'use strict';

const { Op } = require('sequelize');
const { randomUUID: uuidv4 } = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const { getClientInfo, getDevice, isBot } = require('./clientDetect');
const suspicion = require('./traffic/suspicion');
const trafficCounters = require('./traffic/trafficCounters');
const { hashIp } = require('./traffic/ipHash');

const HOUR_MS = 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = HOUR_MS;
const PAST_TOLERANCE_MS = 7 * 24 * HOUR_MS;
const METADATA_MAX_BYTES = 2048;
const VISIT_TIMEOUT_MS = 30 * 60 * 1000; // Umami: a visit expires after 30 minutes of inactivity

const EVENT_TYPE = { pageView: 1, customEvent: 2, linkEvent: 3, pixelEvent: 4 };

/** Client metadata lands in a JSONB column on every hit; anything over 2KB is dropped, the event kept. */
function boundedMetadata(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.stringify(value).length <= METADATA_MAX_BYTES ? value : {};
  } catch {
    return {};
  }
}

/** Coarse device class from the User-Agent; kept for callers of the old helper. */
function deviceFromUserAgent(ua) {
  if (!ua) return 'unknown';
  return getDevice(ua);
}

/** A client-supplied timestamp is only trusted inside a sane window; otherwise "now". */
function resolveOccurredAt(occurredAt, now) {
  if (!occurredAt) return now;
  const t = new Date(occurredAt);
  if (Number.isNaN(t.getTime())) return now;
  if (t.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return now;
  if (t.getTime() < now.getTime() - PAST_TOLERANCE_MS) return now;
  return t;
}

const clip = (v, n) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));
const stripWww = (h) => String(h || '').replace(/^www\./, '');

function safeDecode(s) {
  if (s === null || s === undefined) return s;
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/**
 * Page fields derived from the event's url / referrer, exactly like Umami's
 * /api/send (MIT): path+hash, query, hostname without `www.`, UTM params,
 * referrer domain/path with the domain dropped for self-referrals.
 */
function derivePage({ url, hostname, referrer }) {
  const base = hostname ? `https://${hostname}` : 'https://localhost';
  let current;
  try {
    current = new URL(url || '', base);
  } catch {
    current = new URL('/', base);
  }
  const urlPath = current.pathname === '/undefined' ? '' : current.pathname + current.hash;
  const urlQuery = current.search.substring(1);
  const urlDomain = stripWww(current.hostname);
  const q = current.searchParams;

  let eventDomain = urlDomain;
  if (hostname) {
    try {
      eventDomain = stripWww(new URL(`https://${hostname}`).hostname);
    } catch {
      eventDomain = stripWww(hostname);
    }
  }

  let referrerDomain = null;
  let referrerPath = null;
  if (referrer) {
    try {
      const ref = new URL(referrer, eventDomain ? `https://${eventDomain}` : base);
      referrerPath = ref.pathname;
      referrerDomain = stripWww(ref.hostname);
      // Never save the referrer domain for self-referrals
      if (referrerDomain === eventDomain) referrerDomain = null;
    } catch {
      /* unparsable referrer: ignore */
    }
  }

  // A bare path resolved against the localhost fallback has no real hostname.
  const resolvedHostname = hostname ? eventDomain : urlDomain && urlDomain !== 'localhost' ? urlDomain : null;

  return {
    urlPath: clip(safeDecode(urlPath), 500),
    urlQuery: clip(urlQuery, 500),
    hostname: clip(resolvedHostname, 100),
    referrerDomain: clip(referrerDomain, 500),
    referrerPath: clip(safeDecode(referrerPath), 500),
    utm: {
      source: q.get('utm_source'),
      medium: q.get('utm_medium'),
      campaign: q.get('utm_campaign'),
      content: q.get('utm_content'),
      term: q.get('utm_term'),
    },
    clickIds: { gclid: q.get('gclid'), fbclid: q.get('fbclid'), ttclid: q.get('ttclid') },
  };
}

/**
 * Loads (or creates) the analytics_sessions row for this client session.
 * The first event of a session fixes its browser/os/device/screen/language/
 * geo; later batches never rewrite them. Two concurrent first batches race
 * on the composite PK — the loser re-reads the winner's row.
 */
async function loadSession(workspaceId, body, client, firstEventAt, websiteId, extra = {}) {
  const where = { workspaceId, id: body.sessionId };
  let session = await db.AnalyticsSession.findOne({ where });
  if (session) return session;
  try {
    session = await db.AnalyticsSession.create({
      // The events guard's fields (ip hash, a browser driven by automation), only while it is on.
      ...extra,
      id: body.sessionId,
      workspaceId,
      websiteId: websiteId || null,
      visitorId: body.visitorId,
      browser: client.browser,
      os: client.os,
      device: client.device,
      screen: body.screen || null,
      language: clip(body.language, 35),
      country: client.country,
      region: client.region,
      city: client.city,
      currentVisitId: uuidv4(),
      lastSeenAt: firstEventAt,
      createdAt: firstEventAt,
    });
    return session;
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      return db.AnalyticsSession.findOne({ where });
    }
    throw err;
  }
}

/**
 * Stores a batch of storefront events for one visitor session. The client is
 * never trusted for revenue: a `purchase` that names an order is kept only
 * when that order belongs to the workspace, and its amount is the order's
 * stored total. Repeated dedupeIds are dropped by the unique partial index
 * (ignoreDuplicates), so the browser can safely retry a batch.
 *
 * Every event is tagged with the session's current visit; a visit continues
 * while events keep arriving within 30 minutes of the last one, otherwise a
 * new visit id is minted (Umami semantics). Bots store nothing.
 *
 * `guard` is set by the events guard (traffic/trafficGuard.js) only while
 * TRAFFIC_GUARD_ENABLED is on; without it nothing below changes. With it:
 * the same event twice within a second counts once, a session driven by
 * automation or faster than a person is flagged and its events leave the
 * numbers (traffic/suspicion.js), and past the store's daily cap events are
 * counted rather than stored (traffic/trafficCounters.js) — a purchase of a
 * real order is always stored.
 *
 * Returns the number of events accepted (written or deduped), and
 * `excluded: true` when the batch belonged to a flagged session.
 */
async function ingest(workspaceId, body, { userAgent, getHeader, guard = null } = {}) {
  if (isBot(userAgent)) return { accepted: 0, bot: true };

  const now = new Date();
  const client = getClientInfo({
    userAgent,
    screen: body.screen,
    getHeader: getHeader || (() => undefined),
    trustedGeo: env.analytics.geoHeaders,
  });
  const attribution = body.attribution || {};

  const distinct = (pick) => [...new Set(body.events.map(pick).filter(Boolean))];
  const orderIds = distinct((e) => (e.name === 'purchase' ? e.orderId : null));
  const websiteIds = distinct((e) => e.websiteId);
  const funnelIds = distinct((e) => e.funnelId);

  // website/funnel/order columns are foreign keys: a reference that isn't this
  // workspace's is nulled (or, for a purchase, the event is dropped) rather
  // than letting Postgres reject the whole batch.
  const [orderRows, websiteRows, funnelRows] = await Promise.all([
    orderIds.length ? db.Order.findAll({ where: { workspaceId, id: { [Op.in]: orderIds } }, attributes: ['id', 'totalAmount'], raw: true }) : [],
    websiteIds.length ? db.Website.findAll({ where: { workspaceId, id: { [Op.in]: websiteIds } }, attributes: ['id'], raw: true }) : [],
    funnelIds.length ? db.Funnel.findAll({ where: { workspaceId, id: { [Op.in]: funnelIds } }, attributes: ['id'], raw: true }) : [],
  ]);
  const orders = new Map(orderRows.map((o) => [o.id, o]));
  const websites = new Set(websiteRows.map((w) => w.id));
  const funnels = new Set(funnelRows.map((f) => f.id));

  // Events are processed in order so the visit boundary falls where it did in the browser.
  let timed = body.events.map((e) => ({ e, createdAt: resolveOccurredAt(e.occurredAt, now) }));
  if (guard) {
    timed = withoutDuplicates(workspaceId, body.visitorId, timed, guard);
    if (timed.length === 0) return { accepted: 0 };
  }
  const firstWebsiteId = timed.map(({ e }) => e.websiteId).find((id) => id && websites.has(id)) || null;
  const automation = Boolean(guard) && body.automation === true;
  const extra = guard
    ? {
        ipHash: await hashIp(guard.ip),
        ...(automation ? { isBot: true, flagReason: 'automation', flaggedAt: now } : {}),
      }
    : {};
  const session = await loadSession(workspaceId, body, client, timed[0].createdAt, firstWebsiteId, extra);

  if (guard) {
    const kept = await keptOut(workspaceId, body, session, timed, { automation, orders, country: guard.country || '' });
    if (kept) return { accepted: 0, excluded: true };
  }

  let visitId = session.currentVisitId;
  let lastSeenAt = new Date(session.lastSeenAt).getTime();
  let visitChanged = false;

  const rows = [];
  for (const { e, createdAt } of timed) {
    // Expire visit after 30 minutes
    if (createdAt.getTime() - lastSeenAt > VISIT_TIMEOUT_MS) {
      visitId = uuidv4();
      visitChanged = true;
    }
    lastSeenAt = Math.max(lastSeenAt, createdAt.getTime());

    let orderId = null;
    let revenueAmount = e.revenueAmount === undefined ? null : e.revenueAmount;
    if (e.name === 'purchase' && e.orderId) {
      const order = orders.get(e.orderId);
      if (!order) continue; // not this workspace's order (or doesn't exist): drop
      orderId = order.id;
      revenueAmount = Number(order.totalAmount);
    }

    const page = derivePage({ url: e.url || e.path || '', hostname: body.hostname, referrer: e.referrer });
    const pageUtm = Object.values(page.utm).some(Boolean);
    const data = e.data ? boundedMetadata(e.data) : null;

    rows.push({
      workspaceId,
      websiteId: e.websiteId && websites.has(e.websiteId) ? e.websiteId : null,
      funnelId: e.funnelId && funnels.has(e.funnelId) ? e.funnelId : null,
      visitorId: body.visitorId,
      sessionId: body.sessionId,
      visitId,
      dedupeId: e.dedupeId || null,
      eventName: e.name,
      eventType: e.name === 'page_view' ? EVENT_TYPE.pageView : EVENT_TYPE.customEvent,
      // A page that carries its own utm tags describes itself; the batch's
      // sticky first-touch attribution only fills in for pages that don't.
      // Taking them one by one would mix this page's campaign with an older
      // session's source on the same row.
      source: clip(pageUtm ? page.utm.source : attribution.source, 100),
      medium: clip(pageUtm ? page.utm.medium : attribution.medium, 100),
      campaign: clip(pageUtm ? page.utm.campaign : attribution.campaign, 150),
      referrer: attribution.referrer || null,
      landingPage: attribution.landingPage || null,
      clickIds: attribution.clickIds || (Object.values(page.clickIds).some(Boolean) ? page.clickIds : null),
      orderId,
      revenueAmount,
      metadata: {
        ...boundedMetadata(e.metadata),
        device: client.device,
        ...(e.path ? { path: e.path } : {}),
        ...(data && Object.keys(data).length ? { data } : {}),
      },
      urlPath: page.urlPath,
      urlQuery: page.urlQuery,
      hostname: page.hostname,
      pageTitle: clip(e.title, 500),
      referrerDomain: page.referrerDomain,
      referrerPath: page.referrerPath,
      utmContent: clip(page.utm.content, 255),
      utmTerm: clip(page.utm.term, 255),
      tag: clip(e.tag, 50),
      currency: clip(e.currency, 3),
      screen: body.screen || null,
      language: clip(body.language, 35),
      createdAt,
    });
  }

  let stored = rows;
  if (guard && rows.length > 0) stored = await withinDailyCap(workspaceId, rows);
  if (stored.length > 0) {
    await db.AnalyticsEvent.bulkCreate(stored, { ignoreDuplicates: true });
  }

  const patch = { lastSeenAt: new Date(lastSeenAt) };
  if (visitChanged) patch.currentVisitId = visitId;
  await db.AnalyticsSession.update(patch, { where: { workspaceId, id: body.sessionId } });

  return { accepted: stored.length };
}

/** The batch without events seen within the last second (same visitor, name and page); the rest are counted. */
function withoutDuplicates(workspaceId, visitorId, timed, guard) {
  const kept = timed.filter(
    ({ e, createdAt }) =>
      // A purchase of an order has its own dedupe (dedupeId and the stored order).
      (e.name === 'purchase' && e.orderId) ||
      !suspicion.isDuplicate({ workspaceId, visitorId, name: e.name, page: e.url || e.path || '' }, createdAt.getTime())
  );
  const dropped = timed.length - kept.length;
  if (dropped > 0) trafficCounters.recordFiltered({ workspaceId, kind: 'rejected', reason: 'duplicate', country: guard.country || '', count: dropped });
  return kept;
}

/**
 * True when this batch is kept out of the numbers: its session is (or now
 * becomes) flagged as automation or faster than a person. A batch with a
 * purchase of a real order of this store is never kept out.
 */
async function keptOut(workspaceId, body, session, timed, { automation, orders, country }) {
  const buysRealOrder = timed.some(({ e }) => e.name === 'purchase' && e.orderId && orders.has(e.orderId));
  if (buysRealOrder) return false;
  let flagged = session.isBot || session.isSuspicious;
  if (!flagged && automation) flagged = await suspicion.flagSession(workspaceId, body.sessionId, 'automation', { country });
  const views = timed.filter(({ e }) => e.name === 'page_view').length;
  if (!flagged && suspicion.tooFast(workspaceId, body.visitorId, views)) {
    flagged = await suspicion.flagSession(workspaceId, body.sessionId, 'too_fast', { country });
  }
  if (!flagged) return false;
  await suspicion.countExcluded(workspaceId, body.sessionId, {
    reason: session.flagReason || (automation ? 'automation' : 'too_fast'),
    isBot: session.isBot || automation,
    count: timed.length,
    country,
  });
  return true;
}

/**
 * The rows the store may still store today (its daily cap, TRAFFIC_STORE_DAILY_CAP);
 * the others are counted. A purchase of a real order is always stored.
 */
async function withinDailyCap(workspaceId, rows) {
  const orders = rows.filter((r) => r.orderId);
  const rest = rows.filter((r) => !r.orderId);
  const allowed = await trafficCounters.storable(workspaceId, rest.length);
  const kept = [...orders, ...rest.slice(0, allowed)];
  const over = rest.slice(allowed);
  if (over.length > 0) {
    trafficCounters.addOverflow(workspaceId, { events: over.length, pageViews: over.filter((r) => r.eventType === EVENT_TYPE.pageView).length });
  }
  trafficCounters.addStored(workspaceId, kept.length);
  return kept;
}

module.exports = { ingest, deviceFromUserAgent, resolveOccurredAt, derivePage, EVENT_TYPE, VISIT_TIMEOUT_MS };
