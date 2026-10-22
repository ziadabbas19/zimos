'use strict';

const crypto = require('crypto');
const db = require('../../../db/models');
const { ValidationError, NotFoundError } = require('../../../core/errors/AppError');
const { STAGE_SQL, LATEST_SHIPMENT_JOIN, countsAsSaleSql } = require('../../orders/orderStage');
const { governorateCode } = require('../../shipping/governorates');
const { rate } = require('../analyticsService');
const { PLATFORM_OF_SOURCE } = require('../attributionService');

/**
 * The visitors screens — the merchant's "Visitors" section (one store, always:
 * `scope.workspaceId` is the route's tenant) and the console's "Store traffic"
 * (every store, or one when the console picks it). Both read the same queries;
 * only the scope and what is returned differ: the console also gets the store
 * and the session's ip_hash, the merchant never does (no IP, hashed or not,
 * ever leaves for a merchant; a visitor is an anonymous label).
 *
 * Sources: analytics_sessions rows written with TRAFFIC_DETAILS_ENABLED
 * (`detailed`), never one the events guard flagged; page and product panels
 * from the page views in analytics_events (one store at a time). Definitions:
 *
 *   visit        one session (one browser tab's visit to the store)
 *   visitor      one visitor id (the tracker keeps one per store per tab)
 *   funnel       unique visitors who viewed a page → a product → added to the
 *                cart → began checkout → bought (a purchase of a real order);
 *                each step's drop is the share of the step before that did not go on
 *   conversion   visitors who bought ÷ visitors
 *   visible time a page view's time on screen (the tracker's reports); the
 *                averages count only page views that reported one
 *
 * Every query runs in one read transaction with a statement timeout, ranges
 * are at most MAX_DAYS, and lists are paged (at most PAGE_MAX rows).
 */

const RANGES = ['today', '7d', '30d'];
const RETURN_RANGES = { '30d': 30, '90d': 90 };
const MAX_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_MAX = 100;
const TOP = 10;
const STATEMENT_TIMEOUT_MS = 10000;
const MIN_ORDERS_FOR_RATE = 10;
const SORTS = { recent: 's.last_seen_at', started: 's.created_at', pages: 's.page_views' };
const FINISHED = ['delivered', 'returned', 'delivery_failed', 'cancelled'];
const EVENT_LABELS = { view_content: 'view_product', purchase: 'order' };
const SOURCE_SQL = "coalesce(nullif(s.source, ''), nullif(s.referrer_domain, ''), 'direct')";

const toNumber = (v) => (v === null || v === undefined ? 0 : Number(v));
const orNull = (v) => (v === null || v === undefined ? null : Number(v));
const visitorLabel = (visitorId) => `V-${crypto.createHash('sha256').update(String(visitorId)).digest('hex').slice(0, 8)}`;

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The store's time zone and currency (the merchant), or UTC (the console across stores). */
async function scopeContext(scope) {
  if (!scope.workspaceId) return { tz: 'UTC', currency: null };
  const ws = await db.Workspace.findByPk(scope.workspaceId, { attributes: ['timezone', 'defaultCurrency'] });
  if (!ws) throw new NotFoundError('Workspace');
  return { tz: validTimeZone(ws.timezone || 'UTC'), currency: ws.defaultCurrency || 'EGP' };
}

/** [from, to) for a preset (today = since the store's midnight) or explicit dates, at most MAX_DAYS. */
async function resolveWindow({ range, from, to }, tz) {
  const end = to ? new Date(to) : new Date();
  let start;
  if (from) start = new Date(from);
  else if (range === 'today' || !range) {
    const [row] = await db.sequelize.query("SELECT date_trunc('day', now() AT TIME ZONE :tz) AT TIME ZONE :tz AS start", {
      replacements: { tz },
      type: db.Sequelize.QueryTypes.SELECT,
    });
    start = new Date(row.start);
  } else start = new Date(end.getTime() - Number(range.replace('d', '')) * DAY_MS);
  if (start >= end) throw new ValidationError([{ field: 'from', message: '"from" must be before "to"' }], 'Invalid query');
  if (end.getTime() - start.getTime() > MAX_DAYS * DAY_MS + 60 * 1000) {
    throw new ValidationError([{ field: 'from', message: `a period is at most ${MAX_DAYS} days` }], 'Invalid query');
  }
  return { from: start, to: end };
}

/**
 * Runs `fn(query)` in one read transaction whose statements stop after
 * STATEMENT_TIMEOUT_MS. A transaction is one connection, which runs one
 * statement at a time: queries started together are sent one after another.
 */
function readOnly(fn) {
  return db.sequelize.transaction(async (transaction) => {
    await db.sequelize.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`, { transaction });
    let turn = Promise.resolve();
    const query = (sql, replacements) => {
      const run = turn.then(() => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT, transaction }));
      turn = run.catch(() => undefined);
      return run;
    };
    return fn(query);
  });
}

/**
 * The WHERE of the sessions in scope. `dates: false` leaves the period out —
 * the page panels take the period from the page views instead, so a visit that
 * began before it still counts the pages it viewed inside it.
 */
function sessionFilter(scope, filters, window, { dates = true } = {}) {
  const clauses = ['s.detailed = true', 'NOT s.is_bot', 'NOT s.is_suspicious'];
  const replacements = { from: window.from, to: window.to };
  if (dates) clauses.push('s.created_at >= :from', 's.created_at < :to');
  if (scope.workspaceId) {
    clauses.push('s.workspace_id = :workspaceId');
    replacements.workspaceId = scope.workspaceId;
  }
  if (filters.country) {
    clauses.push('s.country = :country');
    replacements.country = filters.country;
  }
  if (filters.governorate) {
    clauses.push('s.governorate = :governorate');
    replacements.governorate = filters.governorate;
  }
  if (filters.device) {
    clauses.push('s.device = :device');
    replacements.device = filters.device;
  }
  if (filters.source) {
    clauses.push(`${SOURCE_SQL} = :source`);
    replacements.source = filters.source;
  }
  return { where: clauses.join(' AND '), replacements };
}

function funnelOf(t) {
  const steps = [
    ['visit', toNumber(t.visitors)],
    ['product', toNumber(t.product)],
    ['cart', toNumber(t.cart)],
    ['checkout', toNumber(t.checkout)],
    ['order', toNumber(t.ordered)],
  ];
  return steps.map(([key, visitors], i) => ({
    key,
    visitors,
    // Of the visitors at the step before, the share who did not reach this one.
    dropRate: i === 0 ? null : rate(Math.max(0, steps[i - 1][1] - visitors), steps[i - 1][1]),
  }));
}

/** The summary: totals, funnel, sources, places, devices; the page panels when one store is in scope. */
async function summary(scope, query = {}) {
  const ctx = await scopeContext(scope);
  const window = await resolveWindow(query, ctx.tz);
  const filters = query;
  const s = sessionFilter(scope, filters, window);
  const pages = sessionFilter(scope, filters, window, { dates: false });
  const rep = { ...s.replacements, tz: ctx.tz };

  return readOnly(async (q) => {
    const [[totals], daily, sources, countries, governorates, devices, browsers] = await Promise.all([
      q(
        `SELECT count(*) AS visits, count(DISTINCT s.visitor_id) AS visitors, coalesce(sum(s.page_views), 0) AS page_views,
                count(DISTINCT s.visitor_id) FILTER (WHERE s.reached_product) AS product,
                count(DISTINCT s.visitor_id) FILTER (WHERE s.reached_cart) AS cart,
                count(DISTINCT s.visitor_id) FILTER (WHERE s.reached_checkout) AS checkout,
                count(DISTINCT s.visitor_id) FILTER (WHERE s.ordered) AS ordered,
                count(*) FILTER (WHERE s.ordered) AS ordered_visits
           FROM analytics_sessions s WHERE ${s.where}`,
        rep
      ),
      q(
        `SELECT to_char(s.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day, count(*) AS visits, count(DISTINCT s.visitor_id) AS visitors
           FROM analytics_sessions s WHERE ${s.where} GROUP BY 1 ORDER BY 1`,
        rep
      ),
      q(
        `SELECT ${SOURCE_SQL} AS source, count(*) AS visits, count(DISTINCT s.visitor_id) AS visitors,
                count(DISTINCT s.visitor_id) FILTER (WHERE s.ordered) AS buyers
           FROM analytics_sessions s WHERE ${s.where} GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP}`,
        rep
      ),
      q(
        `SELECT s.country, count(*) AS visits FROM analytics_sessions s WHERE ${s.where}
          GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP}`,
        rep
      ),
      q(
        `SELECT s.governorate, count(*) AS visits,
                count(*) FILTER (WHERE s.geo_source = 'order_address') AS from_orders
           FROM analytics_sessions s WHERE ${s.where} AND s.governorate IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC`,
        rep
      ),
      q(`SELECT coalesce(s.device, 'unknown') AS device, count(*) AS visits FROM analytics_sessions s WHERE ${s.where} GROUP BY 1 ORDER BY 2 DESC`, rep),
      q(
        `SELECT coalesce(s.browser, 'unknown') AS browser, count(*) AS visits FROM analytics_sessions s WHERE ${s.where}
          GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
        rep
      ),
    ]);

    // Page views are one store's at a time: across every store they would be
    // a scan of the events table, which has no index for that. The sessions
    // are joined only to apply a filter on them: a flagged session's page
    // views have already left analytics_events (traffic/suspicion.js).
    let pagePanels = null;
    if (scope.workspaceId) {
      const prep = { ...pages.replacements };
      const bySession = Boolean(filters.country || filters.governorate || filters.device || filters.source);
      const join = bySession ? `JOIN analytics_sessions s ON s.workspace_id = e.workspace_id AND s.id = e.session_id AND ${pages.where}` : '';
      const inRange = 'e.workspace_id = :workspaceId AND e.created_at >= :from AND e.created_at < :to';
      const [[dwell], topPages, topProducts] = await Promise.all([
        q(`SELECT avg(e.dwell_ms) AS avg_dwell, count(e.dwell_ms) AS timed FROM analytics_events e ${join} WHERE ${inRange} AND e.event_type = 1`, prep),
        q(
          `SELECT e.url_path AS path, count(*) AS views, count(DISTINCT e.session_id) AS visits,
                  avg(e.dwell_ms) AS avg_dwell, count(e.dwell_ms) AS timed
             FROM analytics_events e ${join}
            WHERE ${inRange} AND e.event_type = 1
            GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP}`,
          prep
        ),
        q(
          `WITH v AS (
             SELECT e.metadata->'contentIds'->>0 AS pid, count(*) AS views, count(DISTINCT e.session_id) AS visits
               FROM analytics_events e ${join}
              WHERE ${inRange} AND e.event_name = 'view_content' AND e.metadata->'contentIds'->>0 IS NOT NULL
              GROUP BY 1 ORDER BY 2 DESC LIMIT ${TOP}
           ), d AS (
             SELECT e.product_id::text AS pid, avg(e.dwell_ms) AS avg_dwell, count(e.dwell_ms) AS timed
               FROM analytics_events e ${join}
              WHERE ${inRange} AND e.event_type = 1 AND e.product_id IS NOT NULL
              GROUP BY 1
           )
           SELECT v.pid, v.views, v.visits, d.avg_dwell, d.timed, p.name
             FROM v
             LEFT JOIN d ON d.pid = v.pid
             LEFT JOIN products p ON p.workspace_id = :workspaceId
                    AND p.id = CASE WHEN v.pid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v.pid::uuid END
            ORDER BY v.views DESC`,
          prep
        ),
      ]);
      pagePanels = {
        avgDwellMs: dwell.avg_dwell === null ? null : Math.round(Number(dwell.avg_dwell)),
        timedPageViews: toNumber(dwell.timed),
        topPages: topPages.map((r) => ({
          path: r.path,
          views: toNumber(r.views),
          visits: toNumber(r.visits),
          avgDwellMs: r.avg_dwell === null ? null : Math.round(Number(r.avg_dwell)),
          timedViews: toNumber(r.timed),
        })),
        topProducts: topProducts.map((r) => ({
          productId: r.pid,
          name: r.name || null,
          views: toNumber(r.views),
          visits: toNumber(r.visits),
          avgDwellMs: r.avg_dwell === null ? null : Math.round(Number(r.avg_dwell)),
          timedViews: toNumber(r.timed),
        })),
      };
    }

    // Raw events a store did not keep that day because of its daily cap (counted only).
    let overCap = null;
    if (scope.workspaceId) {
      const [row] = await q(
        `SELECT coalesce(sum(overflow_events), 0) AS events, coalesce(sum(overflow_page_views), 0) AS page_views
           FROM traffic_store_days
          WHERE workspace_id = :workspaceId AND day >= CAST(:from AS date) AND day <= CAST(:to AS date)`,
        { workspaceId: scope.workspaceId, from: window.from, to: window.to }
      );
      overCap = { events: toNumber(row.events), pageViews: toNumber(row.page_views) };
    }

    const visitors = toNumber(totals.visitors);
    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      timeZone: ctx.tz,
      visits: toNumber(totals.visits),
      visitors,
      pageViews: toNumber(totals.page_views),
      orders: toNumber(totals.ordered_visits),
      conversionRate: rate(toNumber(totals.ordered), visitors),
      funnel: funnelOf(totals),
      daily: daily.map((r) => ({ day: r.day, visits: toNumber(r.visits), visitors: toNumber(r.visitors) })),
      sources: sources.map((r) => ({ source: r.source, visits: toNumber(r.visits), visitors: toNumber(r.visitors), conversionRate: rate(toNumber(r.buyers), toNumber(r.visitors)) })),
      countries: countries.map((r) => ({ country: r.country || null, visits: toNumber(r.visits) })),
      governorates: governorates.map((r) => ({
        governorate: r.governorate,
        visits: toNumber(r.visits),
        fromOrders: toNumber(r.from_orders),
        // Visits placed by their IP's region only — shown as approximate.
        approximate: toNumber(r.visits) - toNumber(r.from_orders),
      })),
      devices: devices.map((r) => ({ device: r.device, visits: toNumber(r.visits) })),
      browsers: browsers.map((r) => ({ browser: r.browser, visits: toNumber(r.visits) })),
      pages: pagePanels,
      overCap,
    };
  });
}

/** One session as a list row; `console` adds the store and the IP hash. */
function sessionRow(r, { console: forConsole }) {
  const row = {
    sessionId: r.id,
    visitor: visitorLabel(r.visitor_id),
    startedAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    country: r.country || null,
    city: r.city || null,
    governorate: r.governorate || null,
    // ip_approx: from the IP's region (Cloudflare), approximate; order_address: from the shopper's order.
    geoSource: r.geo_source || null,
    device: r.device || null,
    browser: r.browser || null,
    os: r.os || null,
    source: r.source || null,
    medium: r.medium || null,
    campaign: r.campaign || null,
    utmContent: r.utm_content || null,
    utmTerm: r.utm_term || null,
    referrerDomain: r.referrer_domain || null,
    landingPath: r.landing_path || null,
    clickIds: { gclid: Boolean(r.has_gclid), fbclid: Boolean(r.has_fbclid), ttclid: Boolean(r.has_ttclid) },
    pageViews: toNumber(r.page_views),
    dwellMs: orNull(r.dwell_ms),
    reached: { product: Boolean(r.reached_product), cart: Boolean(r.reached_cart), checkout: Boolean(r.reached_checkout), order: Boolean(r.ordered) },
  };
  if (forConsole) {
    row.workspaceId = r.workspace_id;
    row.storeName = r.store_name || null;
    row.ipHash = r.ip_hash || null;
    row.flagged = r.flag_reason || null;
  }
  return row;
}

const SESSION_COLUMNS = `s.workspace_id, s.id, s.visitor_id, s.created_at, s.last_seen_at, s.country, s.city, s.governorate, s.geo_source,
  s.device, s.browser, s.os, s.source, s.medium, s.campaign, s.utm_content, s.utm_term, s.referrer_domain, s.landing_path,
  s.has_gclid, s.has_fbclid, s.has_ttclid, s.page_views, s.reached_product, s.reached_cart, s.reached_checkout, s.ordered`;

/** One page of visits, newest first by default. */
async function sessions(scope, query = {}, { console: forConsole = false } = {}) {
  const ctx = await scopeContext(scope);
  const window = await resolveWindow(query, ctx.tz);
  const s = sessionFilter(scope, query, window);
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(query.pageSize) || 25));
  const page = Math.max(1, Number(query.page) || 1);
  const sort = SORTS[query.sort] || SORTS.recent;

  return readOnly(async (q) => {
    const [[count], rows] = await Promise.all([
      q(`SELECT count(*) AS n FROM analytics_sessions s WHERE ${s.where}`, s.replacements),
      q(
        `SELECT ${SESSION_COLUMNS}${forConsole ? ', s.ip_hash, s.flag_reason, w.name AS store_name' : ''}
           FROM analytics_sessions s${forConsole ? ' JOIN workspaces w ON w.id = s.workspace_id' : ''}
          WHERE ${s.where}
          ORDER BY ${sort} DESC, s.id
          LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        s.replacements
      ),
    ]);
    // Visible time of the listed visits, from their page views (by session, indexed).
    if (rows.length > 0) {
      const pairs = rows.map((r, i) => `(CAST(:w${i} AS uuid), :s${i})`).join(', ');
      const rep = Object.fromEntries(rows.flatMap((r, i) => [[`w${i}`, r.workspace_id], [`s${i}`, r.id]]));
      const dwell = await q(
        `SELECT e.workspace_id, e.session_id, sum(e.dwell_ms) AS dwell_ms
           FROM analytics_events e
          WHERE (e.workspace_id, e.session_id) IN (${pairs}) AND e.event_type = 1 AND e.dwell_ms IS NOT NULL
          GROUP BY 1, 2`,
        rep
      );
      const byKey = new Map(dwell.map((d) => [`${d.workspace_id}|${d.session_id}`, d.dwell_ms]));
      for (const r of rows) r.dwell_ms = byKey.get(`${r.workspace_id}|${r.id}`) ?? null;
    }
    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      page,
      pageSize: limit,
      total: toNumber(count.n),
      sessions: rows.map((r) => sessionRow(r, { console: forConsole })),
    };
  });
}

/**
 * One visit in order: its pages (with visible time and product) and events
 * (view_product, add_to_cart, begin_checkout, order, …). The console also
 * sees the events of a flagged visit, from quarantine.
 */
async function sessionTimeline(workspaceId, sessionId, { console: forConsole = false } = {}) {
  return readOnly(async (q) => {
    const [session] = await q(
      `SELECT ${SESSION_COLUMNS}, s.is_bot, s.is_suspicious${forConsole ? ', s.ip_hash, s.flag_reason, w.name AS store_name' : ''}
         FROM analytics_sessions s${forConsole ? ' JOIN workspaces w ON w.id = s.workspace_id' : ''}
        WHERE s.workspace_id = :workspaceId AND s.id = :sessionId${forConsole ? '' : ' AND s.detailed = true AND NOT s.is_bot AND NOT s.is_suspicious'}`,
      { workspaceId, sessionId }
    );
    if (!session) throw new NotFoundError('Visit');
    const columns = `e.id, e.event_name, e.event_type, e.url_path, e.page_title, e.dwell_ms, e.product_id, e.order_id,
                     e.revenue_amount, e.created_at, e.metadata->'contentIds'->>0 AS content_id`;
    let events = await q(
      `SELECT ${columns} FROM analytics_events e
        WHERE e.workspace_id = :workspaceId AND e.session_id = :sessionId
        ORDER BY e.created_at, e.id LIMIT 500`,
      { workspaceId, sessionId }
    );
    let quarantined = false;
    if (forConsole && events.length === 0 && (session.is_bot || session.is_suspicious)) {
      events = await q(
        `SELECT ${columns} FROM analytics_quarantine_events e
          WHERE e.workspace_id = :workspaceId AND e.session_id = :sessionId
          ORDER BY e.created_at, e.id LIMIT 500`,
        { workspaceId, sessionId }
      );
      quarantined = true;
    }
    const productIds = [...new Set(events.flatMap((e) => [e.product_id, e.content_id]).filter((id) => /^[0-9a-f-]{36}$/i.test(String(id || ''))))];
    const products = productIds.length
      ? await q('SELECT id, name FROM products WHERE workspace_id = :workspaceId AND id IN (:ids)', { workspaceId, ids: productIds })
      : [];
    const names = new Map(products.map((p) => [p.id, p.name]));
    const timeline = events.map((e) => {
      const productId = e.product_id || (e.event_name === 'view_content' ? e.content_id : null) || null;
      return {
        at: e.created_at,
        type: e.event_type === 1 ? 'page_view' : EVENT_LABELS[e.event_name] || e.event_name,
        path: e.url_path || null,
        title: e.page_title || null,
        dwellMs: orNull(e.dwell_ms),
        productId,
        productName: productId ? names.get(productId) || null : null,
        orderId: e.order_id || null,
        amount: e.event_name === 'purchase' ? orNull(e.revenue_amount) : null,
      };
    });
    const row = sessionRow({ ...session, dwell_ms: timeline.reduce((n, e) => n + (e.dwellMs || 0), 0) || null }, { console: forConsole });
    return { session: row, quarantined, events: timeline };
  });
}

/**
 * Each (utm_source, utm_campaign): visits, visitors, carts, orders, revenue and
 * conversion, with the store's recorded ad spend (ad_spend_daily, entered on
 * the Ads page) for the same days and campaign name, and the cost per order.
 * No spend recorded: spend and CPA are null, never 0.
 */
async function campaigns(scope, query = {}) {
  const ctx = await scopeContext(scope);
  const window = await resolveWindow(query, ctx.tz);
  const s = sessionFilter(scope, query, window);
  const rep = { ...s.replacements, tz: ctx.tz };

  return readOnly(async (q) => {
    const rows = await q(
      `WITH s AS (
         SELECT s.workspace_id, s.id, s.visitor_id, s.reached_cart, coalesce(s.source, '') AS source, coalesce(s.campaign, '') AS campaign
           FROM analytics_sessions s
          WHERE ${s.where} AND (s.source IS NOT NULL OR s.campaign IS NOT NULL)
       ), g AS (
         SELECT workspace_id, source, campaign, count(*) AS visits, count(DISTINCT visitor_id) AS visitors,
                count(*) FILTER (WHERE reached_cart) AS carts
           FROM s GROUP BY 1, 2, 3
       ), o AS (
         SELECT DISTINCT ON (e.order_id) s.workspace_id, s.source, s.campaign, s.visitor_id, e.order_id, ord.total_amount
           FROM s
           JOIN analytics_events e ON e.workspace_id = s.workspace_id AND e.session_id = s.id
           JOIN orders ord ON ord.id = e.order_id
          WHERE e.event_name = 'purchase' AND e.order_id IS NOT NULL
            AND ord.cancelled_at IS NULL AND ord.confirmation_state <> 'rejected' AND ${countsAsSaleSql('ord')}
       ), r AS (
         SELECT workspace_id, source, campaign, count(*) AS orders, sum(total_amount) AS revenue, count(DISTINCT visitor_id) AS buyers
           FROM o GROUP BY 1, 2, 3
       )
       SELECT g.*, coalesce(r.orders, 0) AS orders, coalesce(r.revenue, 0) AS revenue, coalesce(r.buyers, 0) AS buyers,
              w.name AS store_name, w.default_currency AS currency
         FROM g
         LEFT JOIN r USING (workspace_id, source, campaign)
         JOIN workspaces w ON w.id = g.workspace_id
        ORDER BY g.visits DESC
        LIMIT 50`,
      rep
    );
    const stores = [...new Set(rows.map((r) => r.workspace_id))];
    const spendRows = stores.length
      ? await q(
          `SELECT workspace_id, lower(campaign_name) AS campaign, platform, sum(spend_amount) AS spend
             FROM ad_spend_daily
            WHERE workspace_id IN (:stores)
              AND day >= (CAST(:from AS timestamptz) AT TIME ZONE :tz)::date
              AND day <= ((CAST(:to AS timestamptz) - interval '1 second') AT TIME ZONE :tz)::date
            GROUP BY 1, 2, 3`,
          { stores, from: window.from, to: window.to, tz: ctx.tz }
        )
      : [];
    const spendOf = (r) => {
      const platform = PLATFORM_OF_SOURCE[String(r.source).toLowerCase()];
      const matches = spendRows.filter(
        (x) => x.workspace_id === r.workspace_id && r.campaign && x.campaign === r.campaign.toLowerCase() && (!platform || x.platform === platform)
      );
      return matches.length ? matches.reduce((n, x) => n + toNumber(x.spend), 0) : null;
    };
    return {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      campaigns: rows.map((r) => {
        const orders = toNumber(r.orders);
        const spend = spendOf(r);
        return {
          ...(scope.workspaceId ? {} : { workspaceId: r.workspace_id, storeName: r.store_name }),
          source: r.source || null,
          campaign: r.campaign || null,
          visits: toNumber(r.visits),
          visitors: toNumber(r.visitors),
          carts: toNumber(r.carts),
          orders,
          revenue: toNumber(r.revenue),
          currency: r.currency,
          conversionRate: rate(toNumber(r.buyers), toNumber(r.visitors)),
          spend,
          cpa: spend !== null && orders > 0 ? Math.round(spend / orders) : null,
        };
      }),
    };
  });
}

/**
 * Orders per governorate (the province the shopper wrote, read as one of the
 * 27), by how they ended: delivered, returned (came back, or the courier
 * could not deliver) and cancelled (cancelled, or refused on the confirmation
 * call) — the stages of orders/orderStage.js, nothing new. Orders still under
 * way are counted apart and left out of the rates. A governorate with fewer
 * than MIN_ORDERS_FOR_RATE finished orders shows its counts but no rates.
 */
async function governorateOutcomes(scope, query = {}) {
  const days = RETURN_RANGES[query.range] || RETURN_RANGES['90d'];
  const to = new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  return readOnly(async (q) => {
    const rows = await q(
      `SELECT o.shipping_address_snapshot->>'province' AS province, o.shipping_address_snapshot->>'governorate' AS governorate,
              ${STAGE_SQL} AS stage, count(*) AS n
         FROM orders o${LATEST_SHIPMENT_JOIN}
        WHERE o.created_at >= :from AND o.created_at < :to AND ${countsAsSaleSql('o')}
              ${scope.workspaceId ? 'AND o.workspace_id = :workspaceId' : ''}
        GROUP BY 1, 2, 3`,
      { from, to, workspaceId: scope.workspaceId || null }
    );
    const byCode = new Map();
    for (const r of rows) {
      const code = governorateCode(r.province) || governorateCode(r.governorate) || 'other';
      if (!byCode.has(code)) byCode.set(code, { governorate: code, finished: 0, inProgress: 0, delivered: 0, returned: 0, cancelled: 0 });
      const g = byCode.get(code);
      const n = toNumber(r.n);
      if (!FINISHED.includes(r.stage)) g.inProgress += n;
      else {
        g.finished += n;
        if (r.stage === 'delivered') g.delivered += n;
        else if (r.stage === 'cancelled') g.cancelled += n;
        else g.returned += n;
      }
    }
    const governorates = [...byCode.values()]
      .map((g) => {
        const enough = g.finished >= MIN_ORDERS_FOR_RATE;
        return {
          ...g,
          enough,
          deliveryRate: enough ? rate(g.delivered, g.finished) : null,
          returnRate: enough ? rate(g.returned, g.finished) : null,
          cancelRate: enough ? rate(g.cancelled, g.finished) : null,
        };
      })
      .sort((a, b) => b.finished - a.finished || b.inProgress - a.inProgress);
    return { from: from.toISOString(), to: to.toISOString(), minOrders: MIN_ORDERS_FOR_RATE, governorates };
  });
}

module.exports = {
  summary,
  sessions,
  sessionTimeline,
  campaigns,
  governorateOutcomes,
  RANGES,
  RETURN_RANGES,
  SORTS,
  MAX_DAYS,
  PAGE_MAX,
  MIN_ORDERS_FOR_RATE,
  visitorLabel,
};
