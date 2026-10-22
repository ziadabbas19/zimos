'use strict';

const db = require('../../../db/models');
const env = require('../../../config/env');

/**
 * Is this events request coming from a page of the store it names?
 *
 * The workspace in the URL is the caller's claim. A browser sends the page's
 * origin with every cross-origin POST (fetch and sendBeacon alike) and a page
 * cannot change it, so the Origin's host must be one of the store's own:
 *   - <slug>.<PLATFORM_ROOT_DOMAIN>
 *   - <website subdomain>.<PLATFORM_ROOT_DOMAIN> for each of its websites
 *   - its custom domains that are verified (or active) and not suspended
 *   - TRAFFIC_EXTRA_ORIGINS (hosts any store may send from)
 *   - outside production: localhost, 127.0.0.1 and *.localhost (dev stores)
 *
 * A script outside a browser can send any Origin it likes, so this stops
 * pages of other sites (and lazy scripts that send none) from writing into a
 * store's numbers — not a determined forger; the rate limits are for that.
 * The store's hosts are remembered for a minute per process.
 */

const TTL_MS = 60 * 1000;
const cache = new Map();

async function storeHosts(workspaceId) {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hosts;
  const root = String(env.platformRootDomain || '').toLowerCase();
  const [workspace, websites, domains] = await Promise.all([
    db.Workspace.findByPk(workspaceId, { attributes: ['slug'], raw: true }),
    db.Website.findAll({ where: { workspaceId }, attributes: ['subdomain'], raw: true }),
    db.Domain.findAll({ where: { workspaceId, status: ['verified', 'active'], suspendedAt: null }, attributes: ['hostname'], raw: true }),
  ]);
  const hosts = new Set();
  if (workspace && workspace.slug && root) hosts.add(`${workspace.slug}.${root}`.toLowerCase());
  for (const w of websites) if (w.subdomain && root) hosts.add(`${w.subdomain}.${root}`.toLowerCase());
  for (const d of domains) if (d.hostname) hosts.add(String(d.hostname).toLowerCase().replace(/\.$/, ''));
  if (cache.size > 5000) cache.clear();
  cache.set(workspaceId, { at: Date.now(), hosts });
  return hosts;
}

/** The Origin header's host, '' when it is not a URL, null when there is none. */
function originHost(req) {
  const origin = req.get('origin');
  if (!origin || origin === 'null') return null;
  try {
    return new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

const isDevHost = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/**
 * `{ ok: true, host }`, or `{ ok: false, host, reason }` with reason
 * `origin_missing` (no Origin) or `origin_mismatch` (not one of the store's hosts).
 */
async function checkOrigin(req, workspaceId) {
  const host = originHost(req);
  if (host === null) return { ok: false, host: '', reason: 'origin_missing' };
  if (host && !env.isProduction && isDevHost(host)) return { ok: true, host };
  if (host && (env.trafficGuard.extraOrigins || []).includes(host)) return { ok: true, host };
  const hosts = await storeHosts(workspaceId);
  if (host && hosts.has(host)) return { ok: true, host };
  return { ok: false, host, reason: 'origin_mismatch' };
}

/** Drops the remembered hosts (a new domain is otherwise seen within TTL_MS); tests call it between cases. */
function forget(workspaceId) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

module.exports = { checkOrigin, storeHosts, forget };
