'use strict';

const db = require('../../db/models');
const { assertInt } = require('../../core/utils/money');
const { STAGE_SQL, LATEST_SHIPMENT_JOIN, countsAsSaleSql } = require('../orders/orderStage');
const { rate } = require('./analyticsService');
const { resolveReportRange, validTimeZone, daysOf } = require('./reportRange');

/**
 * Sales by UTM: visitors, orders and sales per value of one UTM parameter,
 * with what was confirmed and delivered — the money a COD store is actually
 * paid on.
 *
 * An order is attributed through its own `purchase` event: the storefront
 * stamps every event with the session's first-touch source, medium and
 * campaign (storefrontEventsService.ingest), so the purchase event carries
 * how the buying visit began. utm_content and utm_term are only stored on the
 * page that carried them, so for those two the order takes the value of the
 * first page of the purchase's session that had one (normally its landing
 * page).
 *
 * Every order of the window lands in exactly one row, so the rows add up to
 * the store's real orders and sales:
 *   key = value      a tracked purchase with that value
 *   key = null, tracked = true    a tracked purchase without one (direct)
 *   key = null, tracked = false   no purchase event at all — entered by hand,
 *                                 taken by phone, or the shopper's browser
 *                                 blocked the tracker
 * Values are compared lower-cased and trimmed, so "Facebook" and "facebook "
 * are one row. Orders and sales use the same definitions as the dashboard
 * home (overviewService): orders that count as a sale, sales of the ones not
 * cancelled.
 */

const DIMENSIONS = Object.freeze({
  source: { column: 'source', fromLanding: false },
  medium: { column: 'medium', fromLanding: false },
  campaign: { column: 'campaign', fromLanding: false },
  content: { column: 'utm_content', fromLanding: true },
  term: { column: 'utm_term', fromLanding: true },
});
const GROUP_BY_KEYS = Object.freeze(Object.keys(DIMENSIONS));

/** Narrow the report to one value of these (a drill-down from a row). */
const FILTER_KEYS = Object.freeze(['source', 'medium', 'campaign']);

const MAX_ROWS = 200;

// A purchase event is written when the shopper's browser sends it, stamped
// with the browser's own clock (accepted from 7 days back to 1 hour ahead).
// Its order's created_at is the server's. Looking this far either side of the
// window finds the event of every order placed inside it.
const PURCHASE_LOOKAROUND = "interval '8 days'";

const count = (value) => (value === null || value === undefined ? 0 : Number(value));
const minor = (value) => (value === null || value === undefined ? 0 : assertInt(String(value)));
const norm = (sqlExpr) => `nullif(lower(btrim(${sqlExpr})), '')`;

function run(sql, replacements) {
  return db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
}

function blankRow(key, tracked) {
  return {
    key,
    tracked,
    visitors: 0,
    orders: 0,
    liveOrders: 0,
    cancelledOrders: 0,
    sales: 0,
    averageOrderValue: 0,
    confirmedOrders: 0,
    deliveredOrders: 0,
    deliveredSales: 0,
  };
}

async function getUtmReport(workspaceId, query = {}) {
  const range = resolveReportRange(query, { defaultDays: 30 });
  const groupBy = DIMENSIONS[query.groupBy] ? query.groupBy : 'source';
  const dim = DIMENSIONS[groupBy];

  const workspace = await db.Workspace.findOne({ where: { id: workspaceId }, attributes: ['defaultCurrency', 'timezone'] });
  const tz = validTimeZone(workspace && workspace.timezone);

  const filters = {};
  const replacements = { workspaceId, start: range.start, end: range.end, tz };
  const eventFilter = [];
  const purchaseFilter = [];
  for (const key of FILTER_KEYS) {
    const value = typeof query[key] === 'string' ? query[key].trim().toLowerCase() : '';
    if (!value) continue;
    filters[key] = value;
    replacements[`f_${key}`] = value;
    eventFilter.push(`AND ${norm(`e.${DIMENSIONS[key].column}`)} = :f_${key}`);
    purchaseFilter.push(`AND ${norm(`p.${DIMENSIONS[key].column}`)} = :f_${key}`);
  }

  const visitorKey = norm(`e.${dim.column}`);
  const orderKey = dim.fromLanding ? norm(`l.${dim.column}`) : norm(`p.${dim.column}`);
  // The first page of the buying session that carried the tag. Events of one
  // batch share a timestamp, so "first" cannot simply be the earliest row.
  const landingJoin = dim.fromLanding
    ? `LEFT JOIN LATERAL (
         SELECT x.${dim.column}
           FROM analytics_events x
          WHERE x.workspace_id = :workspaceId AND x.session_id = p.session_id AND x.created_at <= p.created_at
            AND ${norm(`x.${dim.column}`)} IS NOT NULL
          ORDER BY x.created_at, x.id
          LIMIT 1
       ) l ON p.session_id IS NOT NULL`
    : '';

  const [visitorRows, orderRows] = await Promise.all([
    run(
      `WITH ev AS (
         SELECT e.visitor_id, ${visitorKey} AS key,
                to_char(e.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day
           FROM analytics_events e
          WHERE e.workspace_id = :workspaceId AND e.created_at >= :start AND e.created_at < :end
                ${eventFilter.join(' ')}
       )
       SELECT GROUPING(key) AS key_rolled, GROUPING(day) AS day_rolled, key, day,
              count(DISTINCT visitor_id) AS visitors
         FROM ev
        GROUP BY GROUPING SETS ((key), (day), ())`,
      replacements
    ),
    run(
      `WITH ord AS (
         SELECT o.id, o.total_amount, o.payment_method, o.confirmation_state,
                (o.cancelled_at IS NOT NULL) AS merchant_cancelled,
                (o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected') AS live,
                ${STAGE_SQL} AS stage,
                to_char(o.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day
           FROM orders o${LATEST_SHIPMENT_JOIN}
          WHERE o.workspace_id = :workspaceId
            AND o.created_at >= :start AND o.created_at < :end
            AND ${countsAsSaleSql('o')}
       ),
       purchase AS (
         SELECT DISTINCT ON (e.order_id) e.order_id, e.session_id, e.created_at, e.source, e.medium, e.campaign
           FROM analytics_events e
          WHERE e.workspace_id = :workspaceId AND e.event_name = 'purchase' AND e.order_id IS NOT NULL
            AND e.created_at >= :start::timestamptz - ${PURCHASE_LOOKAROUND}
            AND e.created_at < :end::timestamptz + ${PURCHASE_LOOKAROUND}
          ORDER BY e.order_id, e.created_at, e.id
       ),
       attributed AS (
         SELECT ord.*, (p.order_id IS NOT NULL) AS tracked, ${orderKey} AS key
           FROM ord
           LEFT JOIN purchase p ON p.order_id = ord.id
           ${landingJoin}
          WHERE TRUE ${purchaseFilter.join(' ')}
       )
       SELECT GROUPING(key, tracked) AS key_rolled, GROUPING(day) AS day_rolled, key, tracked, day,
              count(*) AS orders,
              count(*) FILTER (WHERE tracked) AS tracked_orders,
              count(*) FILTER (WHERE live) AS live_orders,
              coalesce(sum(total_amount) FILTER (WHERE live), 0) AS sales,
              coalesce(round(avg(total_amount) FILTER (WHERE live)), 0) AS average_order_value,
              count(*) FILTER (WHERE payment_method = 'cod' AND NOT merchant_cancelled
                               AND confirmation_state = 'confirmed') AS confirmed,
              count(*) FILTER (WHERE stage = 'delivered') AS delivered,
              coalesce(sum(total_amount) FILTER (WHERE stage = 'delivered'), 0) AS delivered_sales
         FROM attributed
        GROUP BY GROUPING SETS ((key, tracked), (day), ())`,
      replacements
    ),
  ]);

  // GROUPING() is 0 for the columns a row is grouped by and non-zero for the
  // ones rolled up: a per-key row has the day rolled up, a per-day row the
  // key, and the grand total both.
  const kind = (row) => {
    const keyRolled = Number(row.key_rolled) !== 0;
    const dayRolled = Number(row.day_rolled) !== 0;
    if (keyRolled && dayRolled) return 'total';
    return dayRolled ? 'key' : 'day';
  };

  const rows = new Map();
  const rowFor = (key, tracked) => {
    const id = tracked ? `tracked:${key === null ? '' : `=${key}`}` : 'untracked';
    if (!rows.has(id)) rows.set(id, blankRow(key, tracked));
    return rows.get(id);
  };

  let totalVisitors = 0;
  let orderTotals = {};
  const series = new Map(daysOf(range, tz).map((date) => [date, { date, visitors: 0, orders: 0, sales: 0 }]));
  const dayRow = (date) => {
    if (!series.has(date)) series.set(date, { date, visitors: 0, orders: 0, sales: 0 });
    return series.get(date);
  };

  for (const row of visitorRows) {
    const k = kind(row);
    if (k === 'total') totalVisitors = count(row.visitors);
    else if (k === 'key') rowFor(row.key, true).visitors = count(row.visitors);
    else dayRow(row.day).visitors = count(row.visitors);
  }
  for (const row of orderRows) {
    const k = kind(row);
    if (k === 'total') {
      orderTotals = row;
    } else if (k === 'day') {
      Object.assign(dayRow(row.day), { orders: count(row.orders), sales: minor(row.sales) });
    } else {
      const target = rowFor(row.key, Boolean(row.tracked));
      Object.assign(target, {
        orders: count(row.orders),
        liveOrders: count(row.live_orders),
        cancelledOrders: count(row.orders) - count(row.live_orders),
        sales: minor(row.sales),
        averageOrderValue: minor(row.average_order_value),
        confirmedOrders: count(row.confirmed),
        deliveredOrders: count(row.delivered),
        deliveredSales: minor(row.delivered_sales),
      });
    }
  }

  const ordered = Array.from(rows.values())
    .map((row) => ({ ...row, conversionRate: row.tracked ? rate(row.orders, row.visitors) : null }))
    .sort(
      (a, b) =>
        b.sales - a.sales ||
        b.orders - a.orders ||
        b.visitors - a.visitors ||
        String(a.key === null ? '' : a.key).localeCompare(String(b.key === null ? '' : b.key))
    );

  const orders = count(orderTotals.orders);
  const trackedOrders = count(orderTotals.tracked_orders);
  return {
    range: { from: range.start.toISOString(), to: range.end.toISOString(), timeZone: tz },
    currency: (workspace && workspace.defaultCurrency) || 'EGP',
    groupBy,
    filters,
    totals: {
      visitors: totalVisitors,
      orders,
      trackedOrders,
      sales: minor(orderTotals.sales),
      averageOrderValue: minor(orderTotals.average_order_value),
      confirmedOrders: count(orderTotals.confirmed),
      deliveredOrders: count(orderTotals.delivered),
      deliveredSales: minor(orderTotals.delivered_sales),
      // Only orders the storefront saw can be set against its visitors.
      conversionRate: rate(trackedOrders, totalVisitors),
    },
    rows: ordered.slice(0, MAX_ROWS),
    truncated: ordered.length > MAX_ROWS,
    series: Array.from(series.values()).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

module.exports = { getUtmReport, GROUP_BY_KEYS, FILTER_KEYS, MAX_ROWS };
