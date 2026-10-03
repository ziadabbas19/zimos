'use strict';

const db = require('../../db/models');
const { assertInt } = require('../../core/utils/money');
const { STAGE_SQL, LATEST_SHIPMENT_JOIN, countsAsSaleSql } = require('../orders/orderStage');
const { rate } = require('./analyticsService');
const { resolveReportRange, previousRange, validTimeZone, daysOf } = require('./reportRange');

/**
 * The dashboard home: the store's numbers for a window and for the window of
 * the same length just before it, a per-day series of each, and the products
 * that sold most. Read-only, aggregated in Postgres over indexed columns —
 * nothing is loaded row by row into the API process.
 *
 * Definitions, so every number can be explained to a merchant:
 *
 *   orders             orders placed in the window that count as a sale: a
 *                      prepaid order that was never paid is an abandoned
 *                      payment, not an order (orderStage.countsAsSaleSql)
 *   cancelledOrders    those orders that were cancelled or rejected
 *   sales              total of those orders that are not cancelled/rejected
 *   averageOrderValue  sales ÷ orders not cancelled/rejected (minor units)
 *   collected          amount paid on the window's orders so far
 *   confirmationRate   COD orders confirmed ÷ COD orders whose call ended
 *                      (confirmed, rejected or unreachable), merchant
 *                      cancellations aside — as on the analytics page
 *   deliveryRate       delivered ÷ orders that left with a courier
 *   sessions           storefront sessions (analytics_events)
 *   conversionRate     tracked purchases ÷ sessions, as on the analytics page
 *   newCustomers       buyers in the window whose first order ever is in it
 *   returningCustomers buyers in the window who had ordered before it
 *
 * Rates are percentages with one decimal, or null when there is nothing to
 * divide by — a rate over zero orders is not 0%.
 */

const SHIPPED_STAGES = ['shipped', 'out_for_delivery', 'delivery_failed', 'delivered', 'returned'];
const TOP_PRODUCTS = 5;

// The home is opened again and again: a minute-old answer is good enough,
// and identical requests in flight share one computation.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();

const count = (value) => (value === null || value === undefined ? 0 : Number(value));
// Sums and averages of BIGINT minor units arrive as numeric strings.
const minor = (value) => (value === null || value === undefined ? 0 : assertInt(String(value)));

function run(sql, replacements) {
  return db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
}

/** The window's orders, one row each, with what the aggregates need. */
const ORDERS_CTE = `
  SELECT o.id, o.customer_id, o.total_amount, o.amount_paid, o.payment_method, o.confirmation_state,
         (o.cancelled_at IS NOT NULL) AS merchant_cancelled,
         (o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected') AS live,
         ${STAGE_SQL} AS stage,
         (o.created_at AT TIME ZONE :tz)::date AS day
    FROM orders o${LATEST_SHIPMENT_JOIN}
   WHERE o.workspace_id = :workspaceId
     AND o.created_at >= :start AND o.created_at < :end
     AND ${countsAsSaleSql('o')}`;

/** Every number of one window: one row per day plus the window's total row. */
async function collectWindow(workspaceId, { start, end }, tz) {
  const replacements = { workspaceId, start, end, tz, shippedStages: SHIPPED_STAGES };
  const [orderRows, [customers], sessionRows, [purchases]] = await Promise.all([
    run(
      `WITH ord AS (${ORDERS_CTE})
       SELECT GROUPING(day) AS is_total, day::text AS day,
              count(*) AS orders,
              count(*) FILTER (WHERE live) AS live_orders,
              count(*) FILTER (WHERE NOT live) AS cancelled,
              coalesce(sum(total_amount) FILTER (WHERE live), 0) AS sales,
              coalesce(round(avg(total_amount) FILTER (WHERE live)), 0) AS average_order_value,
              coalesce(sum(amount_paid), 0) AS collected,
              count(*) FILTER (WHERE payment_method = 'cod' AND NOT merchant_cancelled
                               AND confirmation_state = 'confirmed') AS confirmed,
              count(*) FILTER (WHERE payment_method = 'cod' AND NOT merchant_cancelled
                               AND confirmation_state IN ('confirmed', 'rejected', 'unreachable')) AS decided,
              count(*) FILTER (WHERE stage IN (:shippedStages)) AS shipped,
              count(*) FILTER (WHERE stage = 'delivered') AS delivered
         FROM ord
        GROUP BY GROUPING SETS ((day), ())`,
      replacements
    ),
    run(
      `WITH ord AS (${ORDERS_CTE}),
            buyers AS (SELECT DISTINCT customer_id FROM ord)
       SELECT count(*) FILTER (WHERE f.first_at >= :start) AS new_customers,
              count(*) FILTER (WHERE f.first_at < :start) AS returning_customers
         FROM buyers b
         JOIN LATERAL (
           SELECT min(x.created_at) AS first_at
             FROM orders x
            WHERE x.workspace_id = :workspaceId AND x.customer_id = b.customer_id
         ) f ON TRUE`,
      replacements
    ),
    // Sessions per day and in all: each (day, session) pair once, then
    // counted. Cheaper on millions of events than count(DISTINCT) under
    // GROUPING SETS, which sorts every event once per grouping.
    run(
      `WITH pairs AS MATERIALIZED (
         SELECT (e.created_at AT TIME ZONE :tz)::date AS day, coalesce(e.session_id, e.visitor_id) AS sid
           FROM analytics_events e
          WHERE e.workspace_id = :workspaceId AND e.created_at >= :start AND e.created_at < :end
          GROUP BY 1, 2
       )
       SELECT day::text AS day, count(*) AS sessions FROM pairs GROUP BY day
       UNION ALL
       SELECT NULL, count(*) FROM (SELECT sid FROM pairs GROUP BY sid) s`,
      replacements
    ),
    run(
      `SELECT count(DISTINCT e.order_id) FILTER (WHERE e.order_id IS NOT NULL) AS purchase_orders,
              count(*) FILTER (WHERE e.order_id IS NULL) AS purchases_without_order
         FROM analytics_events e
        WHERE e.workspace_id = :workspaceId AND e.event_name = 'purchase'
          AND e.created_at >= :start AND e.created_at < :end`,
      replacements
    ),
  ]);

  const isTotal = (row) => Number(row.is_total) === 1;
  const orderTotals = orderRows.find(isTotal) || {};
  const sessionTotal = sessionRows.find((row) => row.day === null) || {};

  const series = new Map(daysOf({ start, end }, tz).map((date) => [date, { date, orders: 0, sales: 0, sessions: 0 }]));
  const dayRow = (date) => {
    if (!series.has(date)) series.set(date, { date, orders: 0, sales: 0, sessions: 0 });
    return series.get(date);
  };
  for (const row of orderRows.filter((r) => !isTotal(r))) {
    Object.assign(dayRow(row.day), { orders: count(row.orders), sales: minor(row.sales) });
  }
  for (const row of sessionRows.filter((r) => r.day !== null)) dayRow(row.day).sessions = count(row.sessions);

  // Same rule as analyticsService.getTraffic: orders a purchase event named,
  // or, when none named one, the purchase events themselves.
  const sessions = count(sessionTotal.sessions);
  const purchaseOrders = count(purchases && purchases.purchase_orders);
  const purchaseCount = purchaseOrders > 0 ? purchaseOrders : count(purchases && purchases.purchases_without_order);

  return {
    metrics: {
      sales: minor(orderTotals.sales),
      orders: count(orderTotals.orders),
      averageOrderValue: minor(orderTotals.average_order_value),
      cancelledOrders: count(orderTotals.cancelled),
      collected: minor(orderTotals.collected),
      confirmationRate: rate(count(orderTotals.confirmed), count(orderTotals.decided)),
      deliveryRate: rate(count(orderTotals.delivered), count(orderTotals.shipped)),
      deliveredOrders: count(orderTotals.delivered),
      sessions,
      conversionRate: rate(purchaseCount, sessions),
      newCustomers: count(customers && customers.new_customers),
      returningCustomers: count(customers && customers.returning_customers),
    },
    series: Array.from(series.values()).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

async function topProducts(workspaceId, { start, end }, tz) {
  const rows = await run(
    `WITH ord AS (${ORDERS_CTE})
     SELECT i.product_id, max(i.product_name_snapshot) AS name,
            sum(i.quantity) AS quantity, coalesce(sum(i.line_total_amount), 0) AS sales
       FROM ord
       JOIN order_items i ON i.order_id = ord.id
      WHERE ord.live
      GROUP BY i.product_id, CASE WHEN i.product_id IS NULL THEN i.product_name_snapshot END
      ORDER BY quantity DESC, sales DESC, name
      LIMIT ${TOP_PRODUCTS}`,
    { workspaceId, start, end, tz }
  );
  return rows.map((r) => ({ productId: r.product_id, name: r.name, quantity: count(r.quantity), sales: minor(r.sales) }));
}

async function computeOverview(workspaceId, range, { compare }) {
  const workspace = await db.Workspace.findOne({ where: { id: workspaceId }, attributes: ['defaultCurrency', 'timezone'] });
  const tz = validTimeZone(workspace && workspace.timezone);
  const before = compare ? previousRange(range) : null;

  const [current, previous, products] = await Promise.all([
    collectWindow(workspaceId, range, tz),
    before ? collectWindow(workspaceId, before, tz) : Promise.resolve(null),
    topProducts(workspaceId, range, tz),
  ]);

  const metrics = {};
  for (const [key, value] of Object.entries(current.metrics)) {
    metrics[key] = { value, previous: previous ? previous.metrics[key] : null };
  }

  return {
    range: { from: range.start.toISOString(), to: range.end.toISOString(), timeZone: tz },
    previousRange: before ? { from: before.start.toISOString(), to: before.end.toISOString() } : null,
    currency: (workspace && workspace.defaultCurrency) || 'EGP',
    generatedAt: new Date().toISOString(),
    metrics,
    series: current.series,
    previousSeries: previous ? previous.series : null,
    topProducts: products,
  };
}

/**
 * GET /analytics/overview. The window is rounded to whole minutes
 * (reportRange.resolveReportRange), which is also what makes the short cache
 * hit: the same store asking for the same window within CACHE_TTL_MS gets the
 * same answer. The key carries the workspace id, and the route has already
 * checked the caller's membership and analytics.view before this runs.
 */
function getOverview(workspaceId, query = {}) {
  const range = resolveReportRange(query, { defaultDays: 30 });
  const compare = query.compare !== 'none';
  const key = [workspaceId, range.start.toISOString(), range.end.toISOString(), compare ? 'previous' : 'none'].join('|');

  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;
  if (hit) cache.delete(key);

  const promise = computeOverview(workspaceId, range, { compare });
  cache.set(key, { promise, expiresAt: now + CACHE_TTL_MS });
  // A failure is never served from the cache.
  promise.catch(() => {
    if (cache.get(key) && cache.get(key).promise === promise) cache.delete(key);
  });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return promise;
}

/** Empties the cache (tests). */
function clearOverviewCache() {
  cache.clear();
}

module.exports = { getOverview, clearOverviewCache, CACHE_TTL_MS, SHIPPED_STAGES };
