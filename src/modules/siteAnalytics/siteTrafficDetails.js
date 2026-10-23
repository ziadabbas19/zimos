'use strict';

const { NotFoundError } = require('../../core/errors/AppError');
const { readOnly } = require('../analytics/traffic/visitorInsightsService');
const protection = require('../analytics/traffic/protectionService');

/**
 * zimos.co visits with the same detail as a store's (the console's Site
 * visits, SITE_TRAFFIC_DETAILS_ENABLED). Read from site_visits: one row per
 * event, no IP, a visitor_hash that changes every UTC day, and every time the
 * server's (a ping is PING_SECONDS whatever the browser says).
 *
 * A session is described by its first view: where it came from (UTM, else the
 * referring host, else direct), its landing page, country, governorate,
 * device and browser. The filters apply to that. Days are UTC days, as the
 * existing Site traffic summary counts them.
 *
 *   funnel      sessions that viewed a page → clicked the sign-up link → created
 *               an account. A click recorded before the link kind was kept
 *               (cta_kind null) counts as a sign-up click.
 *   visitors    a visitor_hash per day, so over several days the sum of each day's
 *   time        pings × 15 s, per session and per page
 *
 * Every query runs in one read transaction with a 10 s statement timeout
 * (traffic/visitorInsightsService.readOnly).
 */

const RANGES = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
const SORTS = { recent: 'a.last_at', started: 's.started_at', pages: 'a.pages' };
const PAGE_MAX = 100;
const TOP = 10;
const SOURCE_SQL = "coalesce(nullif(v.utm_source, ''), nullif(v.referrer_host, ''), 'direct')";

const toNumber = (v) => (v === null || v === undefined ? 0 : Number(v));
const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** [from, now): today since UTC midnight, or the last N UTC days including today. */
function windowOf(range) {
  const days = RANGES[range] || RANGES['7d'];
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from, to: new Date(), range: RANGES[range] ? range : '7d' };
}

/**
 * The sessions in the period with their first view's attributes (`s`), and
 * the filters on them. Rows of these sessions are joined back by session_id.
 */
function sessionsSql(filters) {
  const clauses = [];
  const replacements = {};
  for (const [key, column] of [
    ['country', 'country'],
    ['governorate', 'governorate'],
    ['device', 'device_class'],
    ['source', 'source'],
  ]) {
    if (filters[key]) {
      clauses.push(`s.${column} = :${key}`);
      replacements[key] = filters[key];
    }
  }
  const sql = `
    first_views AS (
      SELECT DISTINCT ON (v.session_id)
             v.session_id, v.created_at AS started_at, ${SOURCE_SQL} AS source,
             v.utm_source, v.utm_medium, v.utm_campaign, v.referrer_host, v.path AS landing,
             v.country, v.governorate, v.device_class, v.browser, v.locale
        FROM site_visits v
       WHERE v.created_at >= :from AND v.created_at < :to AND v.event = 'view'
       ORDER BY v.session_id, v.created_at, v.id
    ),
    s AS (SELECT * FROM first_views s${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}),
    rows AS (
      SELECT v.* FROM site_visits v JOIN s ON s.session_id = v.session_id
       WHERE v.created_at >= :from
    ),
    a AS (
      SELECT r.session_id,
             count(*) FILTER (WHERE r.event = 'view') AS pages,
             coalesce(sum(r.seconds_on_page), 0) AS seconds,
             count(*) FILTER (WHERE r.event = 'cta_click') AS cta_clicks,
             bool_or(r.event = 'cta_click' AND (r.cta_kind IS NULL OR r.cta_kind = 'register')) AS signup_click,
             bool_or(r.event = 'signup') AS signed_up,
             max(r.user_id::text) AS user_id,
             max(r.created_at) AS last_at
        FROM rows r GROUP BY r.session_id
    )`;
  return { sql, replacements };
}

async function summary(query = {}) {
  const window = windowOf(query.range);
  const { sql, replacements } = sessionsSql(query);
  const rep = { ...replacements, from: window.from, to: window.to };
  return readOnly(async (q) => {
    const [[totals], daily, pages, sources, countries, governorates, devices, browsers] = await Promise.all([
      q(
        `WITH ${sql}
         SELECT count(*) AS sessions,
                coalesce(sum(a.pages), 0) AS views,
                coalesce(sum(a.seconds), 0) AS seconds,
                count(*) FILTER (WHERE a.signup_click) AS signup_clicks,
                count(*) FILTER (WHERE a.signed_up) AS signups,
                (SELECT count(*) FROM (SELECT DISTINCT date_trunc('day', r.created_at AT TIME ZONE 'UTC'), r.visitor_hash FROM rows r WHERE r.event <> 'signup') d) AS visitors
           FROM s JOIN a ON a.session_id = s.session_id`,
        rep
      ),
      q(
        `WITH ${sql}
         SELECT to_char(date_trunc('day', r.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE r.event = 'view') AS views,
                count(DISTINCT r.visitor_hash) FILTER (WHERE r.event <> 'signup') AS visitors
           FROM rows r GROUP BY 1 ORDER BY 1`,
        rep
      ),
      q(
        `WITH ${sql}
         SELECT r.path, count(*) FILTER (WHERE r.event = 'view') AS views, coalesce(sum(r.seconds_on_page), 0) AS seconds
           FROM rows r WHERE r.path IS NOT NULL
          GROUP BY 1 HAVING count(*) FILTER (WHERE r.event = 'view') > 0
          ORDER BY 2 DESC, 1 LIMIT ${TOP}`,
        rep
      ),
      q(
        `WITH ${sql}
         SELECT s.source, count(*) AS sessions, count(*) FILTER (WHERE a.signed_up) AS signups
           FROM s JOIN a ON a.session_id = s.session_id GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${TOP}`,
        rep
      ),
      q(`WITH ${sql} SELECT s.country, count(*) AS sessions FROM s GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP}`, rep),
      q(`WITH ${sql} SELECT s.governorate, count(*) AS sessions FROM s WHERE s.governorate IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, rep),
      q(`WITH ${sql} SELECT s.device_class AS device, count(*) AS sessions FROM s GROUP BY 1 ORDER BY 2 DESC`, rep),
      q(`WITH ${sql} SELECT coalesce(s.browser, 'unknown') AS browser, count(*) AS sessions FROM s GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, rep),
    ]);
    const sessions = toNumber(totals.sessions);
    const signupClicks = toNumber(totals.signup_clicks);
    const signups = toNumber(totals.signups);
    return {
      range: window.range,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      sessions,
      views: toNumber(totals.views),
      visitors: toNumber(totals.visitors),
      avgSecondsPerSession: sessions ? Math.round(toNumber(totals.seconds) / sessions) : null,
      signups,
      conversionRate: rate(signups, sessions),
      funnel: [
        { key: 'visit', sessions, dropRate: null },
        { key: 'signup_click', sessions: signupClicks, dropRate: rate(Math.max(0, sessions - signupClicks), sessions) },
        { key: 'signup', sessions: signups, dropRate: rate(Math.max(0, signupClicks - signups), signupClicks) },
      ],
      daily: daily.map((r) => ({ day: r.day, views: toNumber(r.views), visitors: toNumber(r.visitors) })),
      pages: pages.map((r) => {
        const views = toNumber(r.views);
        const seconds = toNumber(r.seconds);
        return { path: r.path, views, seconds, avgSecondsPerView: views ? Math.round(seconds / views) : null };
      }),
      sources: sources.map((r) => ({ source: r.source, sessions: toNumber(r.sessions), signups: toNumber(r.signups) })),
      countries: countries.map((r) => ({ country: r.country || null, sessions: toNumber(r.sessions) })),
      governorates: governorates.map((r) => ({ governorate: r.governorate, sessions: toNumber(r.sessions) })),
      devices: devices.map((r) => ({ device: r.device, sessions: toNumber(r.sessions) })),
      browsers: browsers.map((r) => ({ browser: r.browser, sessions: toNumber(r.sessions) })),
    };
  });
}

/** Per utm source / medium / campaign: sessions, CTA clicks, sign-ups, conversion. */
async function campaigns(query = {}) {
  const window = windowOf(query.range);
  const { sql, replacements } = sessionsSql(query);
  return readOnly(async (q) => {
    const rows = await q(
      `WITH ${sql}
       SELECT s.utm_source, s.utm_medium, s.utm_campaign, count(*) AS sessions,
              coalesce(sum(a.cta_clicks), 0) AS cta_clicks, count(*) FILTER (WHERE a.signed_up) AS signups
         FROM s JOIN a ON a.session_id = s.session_id
        WHERE s.utm_source IS NOT NULL OR s.utm_medium IS NOT NULL OR s.utm_campaign IS NOT NULL
        GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 50`,
      { ...replacements, from: window.from, to: window.to }
    );
    return {
      range: window.range,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      campaigns: rows.map((r) => ({
        source: r.utm_source || null,
        medium: r.utm_medium || null,
        campaign: r.utm_campaign || null,
        sessions: toNumber(r.sessions),
        ctaClicks: toNumber(r.cta_clicks),
        signups: toNumber(r.signups),
        conversionRate: rate(toNumber(r.signups), toNumber(r.sessions)),
      })),
    };
  });
}

/** One page of sessions, newest first by default. */
async function sessions(query = {}) {
  const window = windowOf(query.range);
  const { sql, replacements } = sessionsSql(query);
  const pageSize = Math.min(PAGE_MAX, Math.max(1, Number(query.pageSize) || 25));
  const page = Math.max(1, Number(query.page) || 1);
  const sort = SORTS[query.sort] || SORTS.recent;
  const rep = { ...replacements, from: window.from, to: window.to };
  return readOnly(async (q) => {
    const [[count], rows] = await Promise.all([
      q(`WITH ${sql} SELECT count(*) AS n FROM s`, rep),
      q(
        `WITH ${sql}
         SELECT s.*, a.pages, a.seconds, a.cta_clicks, a.signed_up, a.user_id, a.last_at
           FROM s JOIN a ON a.session_id = s.session_id
          ORDER BY ${sort} DESC, s.session_id
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        rep
      ),
    ]);
    return {
      range: window.range,
      page,
      pageSize,
      total: toNumber(count.n),
      sessions: rows.map((r) => ({
        sessionId: r.session_id,
        startedAt: r.started_at,
        lastSeenAt: r.last_at,
        source: r.source,
        utmSource: r.utm_source || null,
        utmMedium: r.utm_medium || null,
        utmCampaign: r.utm_campaign || null,
        referrerHost: r.referrer_host || null,
        landingPath: r.landing || null,
        locale: r.locale || null,
        country: r.country || null,
        governorate: r.governorate || null,
        device: r.device_class,
        browser: r.browser || null,
        pages: toNumber(r.pages),
        seconds: toNumber(r.seconds),
        ctaClicks: toNumber(r.cta_clicks),
        signedUp: Boolean(r.signed_up),
        userId: r.user_id || null,
      })),
    };
  });
}

/** One session's events in order; the account it created, when it signed up. */
async function sessionTimeline(sessionId) {
  return readOnly(async (q) => {
    const events = await q(
      `SELECT v.event, v.path, v.created_at, v.seconds_on_page, v.cta_kind, v.user_id, v.country, v.governorate,
              v.device_class, v.browser, v.utm_source, v.utm_medium, v.utm_campaign, v.referrer_host, v.locale
         FROM site_visits v WHERE v.session_id = :sessionId
        ORDER BY v.created_at, v.id LIMIT 500`,
      { sessionId }
    );
    if (events.length === 0) throw new NotFoundError('Visit');
    const first = events.find((e) => e.event === 'view') || events[0];
    const signup = events.find((e) => e.event === 'signup' && e.user_id);
    return {
      session: {
        sessionId,
        startedAt: events[0].created_at,
        lastSeenAt: events[events.length - 1].created_at,
        utmSource: first.utm_source || null,
        utmMedium: first.utm_medium || null,
        utmCampaign: first.utm_campaign || null,
        referrerHost: first.referrer_host || null,
        landingPath: first.path || null,
        locale: first.locale || null,
        country: first.country || null,
        governorate: first.governorate || null,
        device: first.device_class,
        browser: first.browser || null,
        seconds: events.reduce((n, e) => n + toNumber(e.seconds_on_page), 0),
        // The console's user page: /users/<id>.
        userId: signup ? signup.user_id : null,
      },
      events: events.map((e) => ({
        at: e.created_at,
        type: e.event === 'cta_click' && e.cta_kind ? `cta_${e.cta_kind}` : e.event,
        path: e.path || null,
        seconds: toNumber(e.seconds_on_page),
        userId: e.user_id || null,
      })),
    };
  });
}

/** What the guard kept out of the beacon, per day (traffic_filter_days, scope site). */
function protectionSummary({ range = '7d' } = {}) {
  return protection.summary({ range: protection.RANGES[range] ? range : '30d', scope: 'site' });
}

module.exports = { summary, campaigns, sessions, sessionTimeline, protectionSummary, RANGES, SORTS, PAGE_MAX, windowOf };
