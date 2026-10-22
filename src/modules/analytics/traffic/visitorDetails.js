'use strict';

const db = require('../../../db/models');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const { governorateCode } = require('../../shipping/governorates');
const { LIMITS, guardEnabled } = require('./guardConfig');
const suspicion = require('./suspicion');

/**
 * What a visit was, written by the events endpoint while TRAFFIC_DETAILS_ENABLED
 * is on (storefrontEventsService calls these; off, none of them runs and a
 * `page_dwell` report is dropped rather than stored as an event).
 *
 *  - On the session's first batch: where it came from (UTM, referrer, landing
 *    page, whether an ad click id came with it — never the id), and the
 *    governorate of the IP's region when Cloudflare names one
 *    (geo_source ip_approx). No region header, no governorate: nothing is guessed.
 *  - On every batch: pages viewed and the funnel steps reached.
 *  - `page_dwell` reports: the visible time of one page view (the tracker
 *    counts only while the tab is visible and sends its last reading when the
 *    page is hidden or left). The highest reading wins; it is capped at
 *    LIMITS.MAX_DWELL_MS and at the time since the page view (plus
 *    LIMITS.DWELL_TOLERANCE_MS). A reading past that is impossible, and with the
 *    guard on it flags the session (suspicion.js).
 *  - A purchase of a real order: the session that bought is `ordered` (with
 *    its order, sessionPatch), and every session of that visitor in the store
 *    takes the order's governorate (geo_source order_address); the IP's stays
 *    in governorate_approx.
 */

// ISO 3166-2:EG (what Cloudflare's cf-region-code holds) → shipping/governorates.js.
// HU (Helwan) and SU (6th of October) are the two governorates folded back
// into Cairo and Giza in 2011; some geo databases still return them.
const ISO_TO_GOVERNORATE = Object.freeze({
  'EG-C': 'cairo',
  'EG-GZ': 'giza',
  'EG-ALX': 'alexandria',
  'EG-KB': 'qalyubia',
  'EG-SHR': 'sharqia',
  'EG-DK': 'dakahlia',
  'EG-GH': 'gharbia',
  'EG-MNF': 'monufia',
  'EG-BH': 'beheira',
  'EG-KFS': 'kafr-el-sheikh',
  'EG-DT': 'damietta',
  'EG-PTS': 'port-said',
  'EG-IS': 'ismailia',
  'EG-SUZ': 'suez',
  'EG-FYM': 'faiyum',
  'EG-BNS': 'beni-suef',
  'EG-MN': 'minya',
  'EG-AST': 'asyut',
  'EG-SHG': 'sohag',
  'EG-KN': 'qena',
  'EG-LX': 'luxor',
  'EG-ASN': 'aswan',
  'EG-BA': 'red-sea',
  'EG-WAD': 'new-valley',
  'EG-MT': 'matrouh',
  'EG-SIN': 'north-sinai',
  'EG-JS': 'south-sinai',
  'EG-HU': 'cairo',
  'EG-SU': 'giza',
});

// The tracker's visible-time report (one per page view, sent again with a
// higher reading each time the page is hidden or left).
const DWELL_EVENT = 'page_dwell';

const detailsEnabled = () => Boolean(env.trafficDetails && env.trafficDetails.enabled);
const clip = (v, n) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));

/** The shipping code of an Egyptian region code (`EG-C`), or null. */
function governorateFromRegion(country, region) {
  if (country !== 'EG' || !region) return null;
  return ISO_TO_GOVERNORATE[String(region).toUpperCase()] || null;
}

function hostOf(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

function pathOf(url) {
  if (!url) return null;
  try {
    return new URL(url, 'https://x.invalid').pathname || null;
  } catch {
    return null;
  }
}

/**
 * The session's own fields, from its first event's page (`page`, from
 * derivePage) and the batch's first-touch attribution. A page with its own
 * UTM values describes itself, as the events do (storefrontEventsService).
 */
function sessionFields({ attribution = {}, page, client }) {
  const pageUtm = Object.values(page.utm).some(Boolean);
  const utm = pageUtm ? page.utm : { source: attribution.source, medium: attribution.medium, campaign: attribution.campaign };
  const clicks = { ...(attribution.clickIds || {}) };
  for (const [key, value] of Object.entries(page.clickIds || {})) if (value) clicks[key] = value;
  const approx = governorateFromRegion(client.country, client.region);
  return {
    detailed: true,
    source: clip(utm.source, 100),
    medium: clip(utm.medium, 100),
    campaign: clip(utm.campaign, 150),
    utmContent: clip(page.utm.content, 255),
    utmTerm: clip(page.utm.term, 255),
    referrerDomain: clip(page.referrerDomain || hostOf(attribution.referrer), 255),
    landingPath: clip(pathOf(attribution.landingPage) || page.urlPath, 500),
    hasGclid: Boolean(clicks.gclid),
    hasFbclid: Boolean(clicks.fbclid),
    hasTtclid: Boolean(clicks.ttclid),
    governorate: approx,
    governorateApprox: approx,
    geoSource: approx ? 'ip_approx' : null,
  };
}

/** Ad click ids as yes/no only (analytics_events.click_ids), never the id itself. */
function clickFlags(clickIds) {
  if (!clickIds) return null;
  const flags = {};
  for (const key of ['gclid', 'fbclid', 'ttclid']) if (clickIds[key]) flags[key] = true;
  return Object.keys(flags).length ? flags : null;
}

/** What one batch adds to its session row: pages and funnel steps. */
function sessionPatch(events, orders) {
  const names = new Set(events.map((e) => e.name));
  const patch = {};
  const views = events.filter((e) => e.name === 'page_view').length;
  if (views) patch.pageViews = db.sequelize.literal(`page_views + ${Number(views)}`);
  if (names.has('view_content')) patch.reachedProduct = true;
  if (names.has('add_to_cart')) patch.reachedCart = true;
  if (names.has('begin_checkout') || names.has('add_payment_info')) patch.reachedCheckout = true;
  const bought = events.filter((e) => e.name === 'purchase' && e.orderId && orders.has(e.orderId));
  if (bought.length) {
    patch.ordered = true;
    patch.lastOrderId = bought[bought.length - 1].orderId;
  }
  return patch;
}

/**
 * Applies the batch's `page_dwell` reports ({ pageViewId, dwellMs, productId?,
 * occurredAt }) to their page views in this session. Returns how many matched.
 */
async function applyDwell(workspaceId, sessionId, reports, { country = '' } = {}) {
  let applied = 0;
  for (const { e, createdAt } of reports) {
    if (!e.pageViewId || typeof e.dwellMs !== 'number') continue;
    try {
      const [row] = await db.sequelize.query(
        `UPDATE analytics_events
            SET dwell_ms = GREATEST(coalesce(dwell_ms, 0),
                                    LEAST(:ms, :max, GREATEST(0, floor(extract(epoch FROM (CAST(:at AS timestamptz) - created_at)) * 1000) + :tolerance))::int),
                product_id = coalesce(product_id, CAST(:productId AS uuid))
          WHERE workspace_id = :workspaceId AND dedupe_id = :dedupeId AND session_id = :sessionId AND event_type = 1
          RETURNING (:ms > floor(extract(epoch FROM (CAST(:at AS timestamptz) - created_at)) * 1000) + :tolerance OR :ms > :max) AS impossible`,
        {
          replacements: {
            workspaceId,
            sessionId,
            dedupeId: `pv:${e.pageViewId}`,
            ms: Math.round(e.dwellMs),
            max: LIMITS.MAX_DWELL_MS,
            tolerance: LIMITS.DWELL_TOLERANCE_MS,
            at: createdAt,
            productId: e.productId || null,
          },
          type: db.Sequelize.QueryTypes.SELECT,
        }
      );
      if (!row) continue;
      applied += 1;
      if (row.impossible && guardEnabled()) {
        await suspicion.flagSession(workspaceId, sessionId, 'impossible_dwell', { country });
        break;
      }
    } catch (err) {
      logger.warn(`[traffic] dwell not applied: ${err.message}`);
    }
  }
  return applied;
}

/**
 * The visitor bought: every session of theirs in this store takes the
 * governorate the shopper wrote on the order, when it names one of the 27
 * (nothing changes otherwise). `bought` are the purchase events' orders,
 * oldest first; the newest wins. Only the governorate: which session bought
 * stays on that session (sessionPatch), so a visit is never counted as an
 * order it did not place.
 */
async function linkOrders(workspaceId, visitorId, bought) {
  const last = bought[bought.length - 1];
  if (!last) return;
  const address = last.shippingAddressSnapshot || {};
  const code = governorateCode(address.province) || governorateCode(address.governorate);
  if (!code) return;
  try {
    await db.sequelize.query(
      `UPDATE analytics_sessions SET governorate = :code, geo_source = 'order_address'
        WHERE workspace_id = :workspaceId AND visitor_id = :visitorId AND detailed`,
      { replacements: { workspaceId, visitorId, code } }
    );
  } catch (err) {
    logger.warn(`[traffic] order governorate not linked: ${err.message}`);
  }
}

module.exports = {
  DWELL_EVENT,
  detailsEnabled,
  governorateFromRegion,
  sessionFields,
  clickFlags,
  sessionPatch,
  applyDwell,
  linkOrders,
  ISO_TO_GOVERNORATE,
};
