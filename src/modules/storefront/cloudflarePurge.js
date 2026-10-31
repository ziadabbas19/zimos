'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { SLUG_PATTERN, SLUG_MAX, RESERVED_SLUGS } = require('../../core/utils/workspaceSlug');

/**
 * Purge-on-publish for the store pages Cloudflare keeps. The storefront
 * answers an anonymous visit to a public page of <slug>.<platform domain>
 * with `public, s-maxage=60, stale-while-revalidate=300`
 * (STOREFRONT_EDGE_CACHE_ENABLED, zimos-frontend docs/edge-cache); a change
 * the store's shoppers see drops that store's pages at the edge at once
 * instead of after s-maxage. storefrontCache.invalidate() calls purgeStore():
 * every audited change to what a store shows, and the few writes outside the
 * audit log that call invalidate() themselves.
 *
 * By hostname ({"hosts": ["<slug>.zimos.co"]}): a store is one host, so this
 * drops every page of that store, whatever its query string, and nothing of
 * any other store. Cloudflare purges by hostname on every plan since April
 * 2025. Nothing here sends purge_everything, a prefix, a tag or a list of
 * URLs, and a host that is not a store's own subdomain (www, api, app, admin,
 * media, customers… — PLATFORM_LABELS) is never sent. Merchant domains are
 * not kept at the edge, so they are not purged.
 *
 * Fire and forget: purgeStore() returns at once and never throws, and nothing
 * it does can fail or slow the merchant's request. Per store, the changes
 * within DEBOUNCE_MS of each other make one purge (at most MAX_WAIT_MS after
 * the first). The stores due by then go in one request (up to
 * MAX_HOSTS_PER_REQUEST hosts), and requests are spaced by a token bucket
 * under the Free plan's purge limit (5 requests a minute, bucket 25, per
 * account). One retry on 429 (after Retry-After) or on 5xx / no answer; then
 * a warning, and the pages expire on their own within s-maxage.
 *
 * The token and the zone id come from CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ZONE_ID only and never go into a log line: what is logged is the
 * hosts, the status and Cloudflare's own error text with both taken out.
 *
 * Off unless CLOUDFLARE_PURGE_ENABLED is exactly "true": off, nothing is
 * queued and nothing is sent. The queue lives in this process's memory: a
 * restart drops what was waiting, and with several processes each keeps its
 * own bucket.
 */

const API = 'https://api.cloudflare.com/client/v4';
const DEBOUNCE_MS = 2000;
const MAX_WAIT_MS = 10000;
const MAX_HOSTS_PER_REQUEST = 30;
// Hosts waiting for a request; past it the oldest are dropped (they expire on their own).
const MAX_QUEUED_HOSTS = 1000;
const TIMEOUT_MS = 10000;
// 5 requests a minute, 5 at once: under the Free plan's limit, with room for
// a second process and a purge by hand from the Cloudflare dashboard.
const BUCKET_SIZE = 5;
const REFILL_MS = 12000;
// Before the one retry: Retry-After on a 429 (at most RETRY_MAX_MS), else these.
const RETRY_DEFAULT_MS = 2000;
const RETRY_429_DEFAULT_MS = 15000;
const RETRY_MAX_MS = 60000;
const ZONE_ID = /^[0-9a-f]{32}$/i;

// Hosts on the platform zone that are not stores. RESERVED_SLUGS can't be a
// store's slug; the others are the zone's own hosts (docs/edge-cache's rule).
const PLATFORM_LABELS = new Set([...RESERVED_SLUGS, 'media', 'customers', 'fallback']);

const enabled = () => env.cloudflarePurge.enabled === true;

function configured() {
  const { apiToken, zoneId } = env.cloudflarePurge;
  return Boolean(apiToken) && ZONE_ID.test(zoneId || '');
}

function platformRoot() {
  return String(env.platformRootDomain || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * `<slug>.<platform domain>` for a store's slug, or null when that host is
 * not a store's own subdomain: a slug that is no DNS label, one of the
 * platform's hosts, or a platform domain that is no domain.
 */
function storeHost(slug) {
  const label = String(slug || '').trim().toLowerCase();
  const root = platformRoot();
  if (!root.includes('.') || !label || label.length > SLUG_MAX || !SLUG_PATTERN.test(label)) return null;
  if (PLATFORM_LABELS.has(label)) return null;
  const host = `${label}.${root}`;
  if (host === env.customDomains.cnameTarget) return null;
  return host;
}

/** Cloudflare's own error text, without the zone id or the token in it (a routing error names the zone). */
function errorText(body) {
  const errors = (body && Array.isArray(body.errors) && body.errors) || [];
  const text = errors
    .map((e) => `${e.code || ''} ${e.message || ''}`.trim())
    .filter(Boolean)
    .join('; ')
    .slice(0, 300);
  return scrub(text);
}

function scrub(text) {
  let out = String(text || '');
  for (const secret of [env.cloudflarePurge.zoneId, env.cloudflarePurge.apiToken]) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });

// ─── state ───────────────────────────────────────────────────────────────────
const due = new Map(); // workspaceId → { firstAt, timer, slugs: Set of earlier slugs }
const queue = new Set(); // hosts waiting for a request, oldest first
let tokens = BUCKET_SIZE;
let refilledAt = Date.now();
let pausedUntil = 0; // after a 429: no request before this
let pumping = false;
let warnedUnconfigured = false;

// ─── rate ────────────────────────────────────────────────────────────────────

/** Takes a request's token: 0 when taken, else how long until one can be. */
function takeToken() {
  const now = Date.now();
  if (now < pausedUntil) return pausedUntil - now;
  tokens = Math.min(BUCKET_SIZE, tokens + (now - refilledAt) / REFILL_MS);
  refilledAt = now;
  if (tokens >= 1) {
    tokens -= 1;
    return 0;
  }
  return Math.ceil((1 - tokens) * REFILL_MS);
}

async function waitForToken() {
  for (;;) {
    const wait = takeToken();
    if (wait === 0) return;
    await sleep(wait);
  }
}

// ─── sending ─────────────────────────────────────────────────────────────────

function retryAfterMs(res) {
  const seconds = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : NaN);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_MAX_MS) : RETRY_429_DEFAULT_MS;
}

/** One request. Answers { ok } or { ok: false, retry, waitMs, status, reason }; never throws. */
async function request(hosts) {
  const { apiToken, zoneId } = env.cloudflarePurge;
  let res;
  try {
    res = await fetch(`${API}/zones/${zoneId}/purge_cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const code = err && err.cause && err.cause.code ? ` (${err.cause.code})` : '';
    return { ok: false, retry: true, waitMs: RETRY_DEFAULT_MS, status: null, reason: timedOut ? 'no answer in time' : `could not be reached${code}` };
  }
  const body = await res.json().catch(() => null);
  if (res.ok && body && body.success === true) return { ok: true, status: res.status };
  const reason = errorText(body) || `answered ${res.status}`;
  if (res.status === 429) return { ok: false, retry: true, waitMs: retryAfterMs(res), status: 429, reason };
  if (res.status >= 500) return { ok: false, retry: true, waitMs: RETRY_DEFAULT_MS, status: res.status, reason };
  // 400 (a host refused), 401/403 (the token lacks Cache Purge): retrying changes nothing.
  return { ok: false, retry: false, status: res.status, reason };
}

/** Purges `hosts` (one token taken already), with one retry. Never throws. */
async function send(hosts) {
  let outcome = await request(hosts);
  if (!outcome.ok && outcome.retry) {
    if (outcome.status === 429) {
      // Cloudflare's bucket is empty: ours is too, and nothing goes before Retry-After.
      tokens = 0;
      refilledAt = Date.now();
      pausedUntil = Date.now() + outcome.waitMs;
    } else {
      await sleep(outcome.waitMs);
    }
    await waitForToken();
    outcome = await request(hosts);
  }
  if (outcome.ok) {
    logger.info('[cloudflare-purge] purged', { hosts });
  } else {
    logger.warn('[cloudflare-purge] purge failed; the pages expire on their own within s-maxage', {
      hosts,
      status: outcome.status,
      reason: outcome.reason,
    });
  }
}

/** Sends what is queued, one request at a time, as the bucket allows. One pump at a time. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.size > 0) {
      await waitForToken();
      const hosts = [...queue].slice(0, MAX_HOSTS_PER_REQUEST);
      for (const host of hosts) queue.delete(host);
      await send(hosts);
    }
  } catch (err) {
    logger.warn('[cloudflare-purge] sending stopped', { error: scrub(err && err.message) });
  } finally {
    pumping = false;
  }
}

function enqueue(hosts) {
  for (const host of hosts) {
    queue.delete(host);
    queue.add(host);
  }
  if (queue.size > MAX_QUEUED_HOSTS) {
    const dropped = [...queue].slice(0, queue.size - MAX_QUEUED_HOSTS);
    for (const host of dropped) queue.delete(host);
    logger.warn('[cloudflare-purge] too many hosts waiting; the oldest were dropped', { dropped: dropped.length });
  }
}

// ─── per store ───────────────────────────────────────────────────────────────

/** A store's wait is over: its host now (and any address it just left) joins the queue. */
async function flushStore(workspaceId) {
  const entry = due.get(workspaceId);
  due.delete(workspaceId);
  const slugs = new Set(entry ? entry.slugs : []);
  try {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'slug'] });
    if (workspace && workspace.slug) slugs.add(workspace.slug);
  } catch (err) {
    logger.warn("[cloudflare-purge] could not read the store's address", { workspaceId, error: err.message });
  }
  const hosts = [...new Set([...slugs].map(storeHost).filter(Boolean))];
  if (hosts.length === 0) return;
  enqueue(hosts);
  await pump();
}

/**
 * Drops the store's pages at the edge, soon: after DEBOUNCE_MS without
 * another change to it, at most MAX_WAIT_MS after the first. `previousSlug`:
 * the address the store just left, purged with its current one.
 */
function purgeStore(workspaceId, { previousSlug = null } = {}) {
  try {
    if (!enabled() || !workspaceId) return;
    if (!configured()) {
      if (!warnedUnconfigured) {
        warnedUnconfigured = true;
        logger.warn('[cloudflare-purge] CLOUDFLARE_PURGE_ENABLED is on without a usable CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID; nothing is purged');
      }
      return;
    }
    const now = Date.now();
    let entry = due.get(workspaceId);
    if (!entry) {
      entry = { firstAt: now, timer: null, slugs: new Set() };
      due.set(workspaceId, entry);
    }
    if (previousSlug) entry.slugs.add(previousSlug);
    clearTimeout(entry.timer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, entry.firstAt + MAX_WAIT_MS - now));
    entry.timer = setTimeout(() => {
      flushStore(workspaceId).catch((err) => logger.warn('[cloudflare-purge] flush failed', { workspaceId, error: scrub(err && err.message) }));
    }, wait);
    if (entry.timer.unref) entry.timer.unref();
  } catch (err) {
    logger.warn('[cloudflare-purge] could not schedule a purge', { workspaceId, error: scrub(err && err.message) });
  }
}

/** Forgets every wait, queued host and token count. For tests. */
function _reset() {
  for (const entry of due.values()) clearTimeout(entry.timer);
  due.clear();
  queue.clear();
  tokens = BUCKET_SIZE;
  refilledAt = Date.now();
  pausedUntil = 0;
  pumping = false;
  warnedUnconfigured = false;
}

module.exports = {
  purgeStore,
  storeHost,
  enabled,
  _reset,
  API,
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  MAX_HOSTS_PER_REQUEST,
  BUCKET_SIZE,
  REFILL_MS,
};
