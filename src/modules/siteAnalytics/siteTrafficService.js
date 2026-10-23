'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { getClientInfo, getDevice, getLocation } = require('../analytics/clientDetect');
const { governorateFromRegion } = require('../analytics/traffic/visitorDetails');

/**
 * Anonymous visits to the marketing site (zimos.co), for the console.
 *
 * Nothing that identifies a person is kept: no IP, no cookie. The browser
 * sends a random id it keeps in localStorage; only an HMAC of that id and the
 * UTC day is stored (visitor_hash), so the same browser is a different
 * visitor every day and the id cannot be recovered. Every time is the
 * server's: a ping counts PING_SECONDS whatever the client says.
 *
 * Unique visitors over several days are therefore the sum of each day's.
 */

const PING_SECONDS = 15;
const RANGES = { today: 1, '7d': 7, '30d': 30 };
const TOP_LIMIT = 10;

// The HMAC key, derived from JWT_ACCESS_SECRET (like the upload URL secret):
// secret without a new variable, and never stored.
function hashKey() {
  return crypto.createHmac('sha256', String(env.jwt.accessSecret)).update('site-analytics-visitor-v1').digest();
}

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function visitorHash(visitorId, date = new Date()) {
  return crypto.createHmac('sha256', hashKey()).update(`${visitorId}:${utcDay(date)}`).digest('hex');
}

function deviceClass(userAgent) {
  if (!userAgent) return 'unknown';
  const device = getDevice(userAgent);
  if (device === 'mobile' || device === 'tablet') return device;
  return 'desktop';
}

// The referrer's host only; the full URL (with its query) is never kept.
function referrerHost(referrer) {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    return host ? host.slice(0, 255) : null;
  } catch {
    return null;
  }
}

const orNull = (v) => (v === undefined || v === '' ? null : v);

async function recordEvent(body, req) {
  if (env.siteAnalytics.detailsEnabled) return recordDetailedEvent(body, req);
  const country = getLocation((name) => req.get(name), env.analytics.geoHeaders).country;
  await db.sequelize.query(
    `INSERT INTO site_visits
       (visitor_hash, session_id, path, locale, referrer_host, utm_source, utm_medium, utm_campaign,
        device_class, country, event, seconds_on_page)
     VALUES
       (:visitorHash, :sessionId, :path, :locale, :referrerHost, :utmSource, :utmMedium, :utmCampaign,
        :deviceClass, :country, :event, :seconds)`,
    {
      replacements: {
        visitorHash: visitorHash(body.visitorId),
        sessionId: body.sessionId,
        path: orNull(body.path),
        locale: orNull(body.locale),
        referrerHost: referrerHost(body.referrer),
        utmSource: orNull(body.utmSource),
        utmMedium: orNull(body.utmMedium),
        utmCampaign: orNull(body.utmCampaign),
        deviceClass: deviceClass(req.get('user-agent')),
        country: country || null,
        event: body.event,
        seconds: body.event === 'ping' ? PING_SECONDS : 0,
      },
      type: QueryTypes.INSERT,
    }
  );
}

/**
 * The same row with SITE_TRAFFIC_DETAILS_ENABLED: also the browser, the
 * governorate (Cloudflare's region header through ANALYTICS_GEO_HEADERS and the
 * store traffic mapping; null without it, nothing guessed) and, for a
 * cta_click, which dashboard link it was.
 */
async function recordDetailedEvent(body, req) {
  const client = getClientInfo({
    userAgent: req.get('user-agent'),
    getHeader: (name) => req.get(name),
    trustedGeo: env.analytics.geoHeaders,
  });
  await db.sequelize.query(
    `INSERT INTO site_visits
       (visitor_hash, session_id, path, locale, referrer_host, utm_source, utm_medium, utm_campaign,
        device_class, country, event, seconds_on_page, browser, governorate, cta_kind)
     VALUES
       (:visitorHash, :sessionId, :path, :locale, :referrerHost, :utmSource, :utmMedium, :utmCampaign,
        :deviceClass, :country, :event, :seconds, :browser, :governorate, :ctaKind)`,
    {
      replacements: {
        visitorHash: visitorHash(body.visitorId),
        sessionId: body.sessionId,
        path: orNull(body.path),
        locale: orNull(body.locale),
        referrerHost: referrerHost(body.referrer),
        utmSource: orNull(body.utmSource),
        utmMedium: orNull(body.utmMedium),
        utmCampaign: orNull(body.utmCampaign),
        deviceClass: deviceClass(req.get('user-agent')),
        country: client.country || null,
        event: body.event,
        seconds: body.event === 'ping' ? PING_SECONDS : 0,
        browser: client.browser || null,
        governorate: governorateFromRegion(client.country, client.region),
        ctaKind: body.event === 'cta_click' ? body.cta || null : null,
      },
      type: QueryTypes.INSERT,
    }
  );
}

/**
 * Links the anonymous session a new account signed up from: its rows get the
 * user id, a 'signup' row is added, and the session's first visit is kept as
 * the account's acquisition. Throws on a database error; linkSignup is the
 * caller that never does.
 */
async function linkSession(userId, sessionId) {
  await db.sequelize.transaction(async (transaction) => {
    const [first] = await db.sequelize.query(
      `SELECT visitor_hash, path, referrer_host, utm_source, utm_medium, utm_campaign, created_at, locale, device_class, country
         FROM site_visits
        WHERE session_id = :sessionId AND event <> 'signup'
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      { replacements: { sessionId }, type: QueryTypes.SELECT, transaction }
    );
    if (!first) return;

    await db.sequelize.query('UPDATE site_visits SET user_id = :userId WHERE session_id = :sessionId AND user_id IS NULL', {
      replacements: { userId, sessionId },
      transaction,
    });
    await db.sequelize.query(
      `INSERT INTO site_visits (visitor_hash, session_id, locale, device_class, country, event, user_id)
       VALUES (:visitorHash, :sessionId, :locale, :deviceClass, :country, 'signup', :userId)`,
      {
        replacements: {
          visitorHash: first.visitor_hash,
          sessionId,
          locale: first.locale,
          deviceClass: first.device_class,
          country: first.country,
          userId,
        },
        transaction,
      }
    );
    await db.sequelize.query(
      `INSERT INTO user_acquisition
         (user_id, session_id, landing_path, referrer_host, utm_source, utm_medium, utm_campaign, first_visit_at)
       VALUES (:userId, :sessionId, :path, :referrerHost, :utmSource, :utmMedium, :utmCampaign, :firstVisitAt)
       ON CONFLICT (user_id) DO NOTHING`,
      {
        replacements: {
          userId,
          sessionId,
          path: first.path,
          referrerHost: first.referrer_host,
          utmSource: first.utm_source,
          utmMedium: first.utm_medium,
          utmCampaign: first.utm_campaign,
          firstVisitAt: first.created_at,
        },
        transaction,
      }
    );
  });
}

/** Called by sign-up. Never throws: a failure here must not fail the account. */
async function linkSignup(userId, sessionId) {
  if (!env.siteAnalytics.enabled || !sessionId) return;
  try {
    await service.linkSession(userId, sessionId);
  } catch (err) {
    logger.warn('site analytics: could not link the sign-up session', { userId, error: err.message });
  }
}

function rangeStart(range) {
  const days = RANGES[range] || 1;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start, days };
}

async function summary(range = 'today') {
  const { start, days } = rangeStart(range);
  const q = (sql) => db.sequelize.query(sql, { replacements: { start, days }, type: QueryTypes.SELECT });

  const [totals] = await q(
    `SELECT
       COUNT(*) FILTER (WHERE event = 'view')::int AS visits,
       COUNT(DISTINCT visitor_hash) FILTER (WHERE event <> 'signup')::int AS unique_visitors,
       COALESCE(SUM(seconds_on_page), 0)::int AS seconds,
       COUNT(DISTINCT session_id) FILTER (WHERE event = 'view')::int AS view_sessions,
       COUNT(DISTINCT session_id) FILTER (WHERE event = 'cta_click')::int AS cta_sessions,
       COUNT(DISTINCT session_id) FILTER (WHERE event = 'signup')::int AS signup_sessions
     FROM site_visits WHERE created_at >= :start`
  );
  const topPages = await q(
    `SELECT path, COUNT(*)::int AS visits
       FROM site_visits WHERE created_at >= :start AND event = 'view' AND path IS NOT NULL
      GROUP BY path ORDER BY visits DESC, path ASC LIMIT ${TOP_LIMIT}`
  );
  // A session's source is that of its first view (later views carry none).
  const topSources = await q(
    `SELECT source, COUNT(*)::int AS sessions
       FROM (SELECT DISTINCT ON (session_id) COALESCE(utm_source, referrer_host, 'direct') AS source
               FROM site_visits WHERE created_at >= :start AND event = 'view'
              ORDER BY session_id, created_at ASC, id ASC) first_views
      GROUP BY source ORDER BY sessions DESC, source ASC LIMIT ${TOP_LIMIT}`
  );
  const daily = await q(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COUNT(v.id) FILTER (WHERE v.event = 'view')::int AS visits,
            COUNT(DISTINCT v.visitor_hash) FILTER (WHERE v.event <> 'signup')::int AS unique_visitors
       FROM generate_series(CAST(:start AS timestamptz) AT TIME ZONE 'UTC', (CAST(:start AS timestamptz) AT TIME ZONE 'UTC') + (CAST(:days AS int) - 1) * INTERVAL '1 day', INTERVAL '1 day') AS d(day)
       LEFT JOIN site_visits v
         ON v.created_at >= :start
        AND date_trunc('day', v.created_at AT TIME ZONE 'UTC') = d.day
      GROUP BY d.day ORDER BY d.day`
  );

  return {
    enabled: env.siteAnalytics.enabled,
    range: RANGES[range] ? range : 'today',
    since: start.toISOString(),
    visits: totals.visits,
    uniqueVisitors: totals.unique_visitors,
    avgSecondsOnSite: totals.view_sessions ? Math.round(totals.seconds / totals.view_sessions) : 0,
    topPages: topPages.map((r) => ({ path: r.path, visits: r.visits })),
    topSources: topSources.map((r) => ({ source: r.source, sessions: r.sessions })),
    funnel: { visit: totals.view_sessions, ctaClick: totals.cta_sessions, signup: totals.signup_sessions },
    daily: daily.map((r) => ({ day: r.day, visits: r.visits, uniqueVisitors: r.unique_visitors })),
  };
}

/** The console's user page: where the account came from, or null. */
async function acquisitionFor(userId) {
  const [row] = await db.sequelize.query('SELECT * FROM user_acquisition WHERE user_id = :userId', {
    replacements: { userId },
    type: QueryTypes.SELECT,
  });
  if (!row) return null;
  const firstVisitAt = new Date(row.first_visit_at);
  const signedUpAt = new Date(row.signed_up_at);
  return {
    landingPath: row.landing_path,
    referrerHost: row.referrer_host,
    utmSource: row.utm_source,
    utmMedium: row.utm_medium,
    utmCampaign: row.utm_campaign,
    firstVisitAt: firstVisitAt.toISOString(),
    signedUpAt: signedUpAt.toISOString(),
    secondsBeforeSignup: Math.max(0, Math.round((signedUpAt - firstVisitAt) / 1000)),
  };
}

const service = {
  PING_SECONDS,
  RANGES,
  visitorHash,
  deviceClass,
  referrerHost,
  recordEvent,
  linkSession,
  linkSignup,
  summary,
  acquisitionFor,
};

module.exports = service;
