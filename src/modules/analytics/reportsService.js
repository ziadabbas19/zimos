'use strict';

const db = require('../../db/models');
const { ValidationError } = require('../../core/errors/AppError');
const { STAGE_SQL, countsAsSaleSql } = require('../orders/orderStage');
const { rate, toNumber, DAY_MS } = require('./analyticsService');
const orderLock = require('../orders/orderLock');

/**
 * The analytics reports: sales, products, delivery (the COD reality) and
 * customers, plus the insights drawn from them. Each report is one request
 * and is aggregated in Postgres; nothing is loaded into the API process.
 *
 * Definitions, so every number can be explained to a merchant:
 *
 *   order             a placed order that counts as a sale (a prepaid order
 *                     never paid is an abandoned payment), test orders excluded
 *   live order        an order that is neither cancelled nor rejected
 *   gross sales       items subtotal of live orders, before discounts
 *   net sales         gross sales − discounts − refunds
 *   total sales       what the customers were asked to pay (net + shipping + tax)
 *   delivered sales   total of the orders that reached the customer — on cash
 *                     on delivery this is the money that actually comes in
 *   conversion rate   orders ÷ sessions
 *   confirmation rate confirmed COD orders ÷ COD orders
 *   delivery rate     delivered ÷ orders that left with a courier
 *   return rate       returned or failed ÷ orders that left with a courier
 *
 * Rates are percentages with one decimal (`rate()` of analyticsService).
 *
 * Money is in the store's base currency, in minor units.
 */

const MAX_RANGE_DAYS = 366;
const DEFAULT_DAYS = 30;
const SHIPPED_STAGES = "('shipped', 'out_for_delivery', 'delivery_failed', 'delivered', 'returned')";
const UNITS = ['hour', 'day', 'week', 'month'];

// Like orderStage's LATEST_SHIPMENT_JOIN, with the carrier and the dates the
// delivery report needs. Keeps the alias `ls` that STAGE_SQL reads.
const SHIPMENT_JOIN = `
    LEFT JOIN LATERAL (
      SELECT s.status, s.carrier_code, s.shipped_at, s.delivered_at
        FROM shipments s
       WHERE s.order_id = o.id
         AND s.status <> 'cancelled'
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT 1
    ) ls ON TRUE`;

const GOVERNORATE_SQL =
  "coalesce(nullif(o.shipping_address_snapshot->>'governorate', ''), nullif(o.shipping_address_snapshot->>'city', ''))";

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function resolveWindow({ from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  let start = from ? new Date(from) : new Date(end.getTime() - DEFAULT_DAYS * DAY_MS);
  if (start >= end) throw new ValidationError([{ field: 'from', message: '"from" must be before "to"' }], 'Invalid query');
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) start = new Date(end.getTime() - MAX_RANGE_DAYS * DAY_MS);
  return { start, end };
}

/** The window before this one (same length), or the same dates a year earlier. */
function previousWindow({ start, end }, compare) {
  if (compare === 'none') return null;
  if (compare === 'year') {
    const shift = (d) => {
      const copy = new Date(d);
      copy.setUTCFullYear(copy.getUTCFullYear() - 1);
      return copy;
    };
    return { start: shift(start), end: shift(end) };
  }
  const span = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - span), end: start };
}

/** Bucket size for the charts when the caller does not pick one. */
function autoUnit({ start, end }) {
  const days = (end.getTime() - start.getTime()) / DAY_MS;
  if (days <= 2) return 'hour';
  if (days <= 92) return 'day';
  if (days <= 185) return 'week';
  return 'month';
}

async function context(workspaceId, query) {
  const window = resolveWindow(query);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  const tz = validTimeZone((workspace && workspace.timezone) || 'UTC');
  const currency = (workspace && workspace.defaultCurrency) || 'EGP';
  return { workspaceId, window, tz, currency };
}

/** Query runner + the two base CTEs (orders with their stage, events) for one window. */
function windowSql(workspaceId, { start, end }, tz) {
  const replacements = { workspaceId, start, end, tz };
  const run = (sql, extra) =>
    db.sequelize.query(sql, { replacements: { ...replacements, ...extra }, type: db.Sequelize.QueryTypes.SELECT });
  // Orders are in the store's currency: no rate is recorded (currencies/baseAmounts.js).
  const fx = '1';
  const ORDERS = `
    SELECT o.id, o.customer_id, o.created_at, o.confirmed_at, o.payment_method, o.confirmation_state,
           o.total_amount AS total,
           round(o.subtotal_amount * ${fx}) AS subtotal,
           round(o.discount_amount * ${fx}) AS discount,
           round(o.shipping_amount * ${fx}) AS shipping,
           round(o.amount_refunded * ${fx}) AS refunded,
           (o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected') AS live,
           ${STAGE_SQL} AS stage,
           ${GOVERNORATE_SQL} AS governorate,
           ls.carrier_code AS carrier, ls.shipped_at, ls.delivered_at
      FROM orders o${SHIPMENT_JOIN}
     WHERE o.workspace_id = :workspaceId AND o.created_at >= :start AND o.created_at < :end
       AND ${countsAsSaleSql('o')}`;
  const EVENTS = `
    SELECT coalesce(e.session_id, e.visitor_id) AS sid, e.id, e.event_name, e.metadata, e.created_at,
           e.order_id, e.source, e.medium, e.referrer_domain, e.url_path, e.landing_page, e.session_id
      FROM analytics_events e
     WHERE e.workspace_id = :workspaceId AND e.created_at >= :start AND e.created_at < :end`;
  // One row per session: where it came from, where it landed, on what device.
  const FIRSTS = `
    SELECT DISTINCT ON (ev.sid) ev.sid,
           coalesce(nullif(ev.source, ''), nullif(ev.referrer_domain, ''), 'direct') AS source,
           nullif(ev.medium, '') AS medium,
           coalesce(nullif(ev.landing_page, ''), nullif(ev.url_path, ''), '/') AS landing,
           coalesce(nullif(s.device, ''), nullif(ev.metadata->>'device', ''), 'unknown') AS device
      FROM ev
      LEFT JOIN analytics_sessions s ON s.id = ev.session_id AND s.workspace_id = :workspaceId
     ORDER BY ev.sid, ev.created_at, ev.id`;
  // The live orders a session ended in.
  const BOUGHT = `
    SELECT DISTINCT ev.sid, ord.id AS order_id, ord.total
      FROM ev JOIN ord ON ord.id = ev.order_id
     WHERE ev.event_name = 'purchase' AND ord.live`;
  return { run, ORDERS, EVENTS, FIRSTS, BOUGHT };
}

const delivery = (r) => ({
  orders: toNumber(r.orders),
  codOrders: toNumber(r.cod_orders),
  confirmed: toNumber(r.confirmed),
  shipped: toNumber(r.shipped),
  delivered: toNumber(r.delivered),
  returned: toNumber(r.returned),
  sales: toNumber(r.sales),
  deliveredSales: toNumber(r.delivered_sales),
  confirmationRate: rate(toNumber(r.confirmed), toNumber(r.cod_orders)),
  deliveryRate: rate(toNumber(r.delivered), toNumber(r.shipped)),
  returnRate: rate(toNumber(r.returned), toNumber(r.shipped)),
});

const DELIVERY_AGG = `
      count(*) AS orders,
      count(*) FILTER (WHERE payment_method = 'cod') AS cod_orders,
      count(*) FILTER (WHERE payment_method = 'cod' AND confirmation_state = 'confirmed') AS confirmed,
      count(*) FILTER (WHERE stage IN ${SHIPPED_STAGES}) AS shipped,
      count(*) FILTER (WHERE stage = 'delivered') AS delivered,
      count(*) FILTER (WHERE stage IN ('returned', 'delivery_failed')) AS returned,
      coalesce(sum(total) FILTER (WHERE live), 0) AS sales,
      coalesce(sum(total) FILTER (WHERE stage = 'delivered'), 0) AS delivered_sales`;

/** Every headline number of one window. */
async function salesTotals(sql) {
  const { run, ORDERS, EVENTS } = sql;
  const [[o], [e], [items], [lost], [customers]] = await Promise.all([
    run(`
      WITH ord AS (${ORDERS})
      SELECT ${DELIVERY_AGG},
             count(*) FILTER (WHERE live) AS live_orders,
             coalesce(sum(subtotal) FILTER (WHERE live), 0) AS gross,
             coalesce(sum(discount) FILTER (WHERE live), 0) AS discounts,
             coalesce(sum(refunded) FILTER (WHERE live), 0) AS refunds,
             coalesce(sum(shipping) FILTER (WHERE live), 0) AS shipping
        FROM ord`),
    run(`
      WITH ev AS (${EVENTS})
      SELECT count(DISTINCT sid) AS sessions,
             count(DISTINCT sid) FILTER (WHERE event_name = 'view_content') AS product_sessions,
             count(DISTINCT sid) FILTER (WHERE event_name = 'add_to_cart') AS cart_sessions,
             count(DISTINCT sid) FILTER (WHERE event_name = 'begin_checkout') AS checkout_sessions,
             count(DISTINCT sid) FILTER (WHERE event_name = 'purchase') AS purchase_sessions
        FROM ev`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT coalesce(sum(i.quantity), 0) AS units
        FROM ord JOIN order_items i ON i.order_id = ord.id
       WHERE ord.live`),
    run(`
      SELECT count(*) AS abandoned,
             coalesce(sum(c.subtotal_amount), 0) AS abandoned_value,
             count(*) FILTER (WHERE c.recovery_status = 'recovered') AS recovered,
             count(*) FILTER (WHERE c.recovery_status = 'not_contacted') AS not_contacted
        FROM checkout_sessions c
       WHERE c.workspace_id = :workspaceId AND c.created_at >= :start AND c.created_at < :end
         AND (c.status = 'abandoned' OR c.recovery_status = 'recovered')`),
    // New = the customer's first ever order falls inside the window.
    run(`
      WITH ord AS (${ORDERS}),
           buyers AS (SELECT customer_id, sum(total) FILTER (WHERE live) AS spent FROM ord WHERE customer_id IS NOT NULL GROUP BY 1)
      SELECT count(*) FILTER (WHERE f.first_at >= :start) AS new_customers,
             count(*) FILTER (WHERE f.first_at < :start) AS returning_customers,
             coalesce(sum(b.spent) FILTER (WHERE f.first_at >= :start), 0) AS new_sales,
             coalesce(sum(b.spent) FILTER (WHERE f.first_at < :start), 0) AS returning_sales
        FROM buyers b
        JOIN LATERAL (
          SELECT min(x.created_at) AS first_at FROM orders x
           WHERE x.workspace_id = :workspaceId AND x.customer_id = b.customer_id
        ) f ON TRUE`),
  ]);

  const d = delivery(o);
  const liveOrders = toNumber(o.live_orders);
  const gross = toNumber(o.gross);
  const discounts = toNumber(o.discounts);
  const refunds = toNumber(o.refunds);
  const sessions = toNumber(e.sessions);
  const newCustomers = toNumber(customers.new_customers);
  const returningCustomers = toNumber(customers.returning_customers);
  const abandoned = toNumber(lost.abandoned);
  return {
    kpis: {
      totalSales: d.sales,
      orders: d.orders,
      averageOrderValue: liveOrders > 0 ? Math.round(d.sales / liveOrders) : 0,
      sessions,
      conversionRate: rate(d.orders, sessions),
      grossSales: gross,
      discounts,
      refunds,
      netSales: gross - discounts - refunds,
      shipping: toNumber(o.shipping),
      unitsSold: toNumber(items.units),
      deliveredSales: d.deliveredSales,
      confirmationRate: d.confirmationRate,
      deliveryRate: d.deliveryRate,
      returnRate: d.returnRate,
      newCustomers,
      returningCustomers,
      returningCustomerRate: rate(returningCustomers, newCustomers + returningCustomers),
      newCustomerSales: toNumber(customers.new_sales),
      returningCustomerSales: toNumber(customers.returning_sales),
      abandonedCheckouts: abandoned,
      abandonedValue: toNumber(lost.abandoned_value),
      recoveredCheckouts: toNumber(lost.recovered),
      recoveryRate: rate(toNumber(lost.recovered), abandoned),
      uncontactedCheckouts: toNumber(lost.not_contacted),
    },
    funnel: {
      sessions,
      product: toNumber(e.product_sessions),
      cart: toNumber(e.cart_sessions),
      checkout: toNumber(e.checkout_sessions),
      purchase: toNumber(e.purchase_sessions),
    },
  };
}

/** One row per bucket of the window, empty buckets included. */
async function salesSeries(sql, unit) {
  const { run, ORDERS, EVENTS } = sql;
  const rows = await run(
    `
    WITH buckets AS (
           SELECT generate_series(
                    date_trunc(:unit, CAST(:start AS timestamptz) AT TIME ZONE :tz),
                    date_trunc(:unit, (CAST(:end AS timestamptz) - interval '1 second') AT TIME ZONE :tz),
                    CAST(:step AS interval)) AS b),
         ord AS (${ORDERS}),
         ev AS (${EVENTS}),
         o AS (
           SELECT date_trunc(:unit, created_at AT TIME ZONE :tz) AS b,
                  count(*) AS orders,
                  count(*) FILTER (WHERE live) AS live_orders,
                  coalesce(sum(total) FILTER (WHERE live), 0) AS sales,
                  coalesce(sum(total) FILTER (WHERE stage = 'delivered'), 0) AS delivered_sales
             FROM ord GROUP BY 1),
         e AS (
           SELECT date_trunc(:unit, created_at AT TIME ZONE :tz) AS b, count(DISTINCT sid) AS sessions
             FROM ev GROUP BY 1)
    SELECT to_char(buckets.b, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
           coalesce(o.orders, 0) AS orders, coalesce(o.live_orders, 0) AS live_orders,
           coalesce(o.sales, 0) AS sales, coalesce(o.delivered_sales, 0) AS delivered_sales,
           coalesce(e.sessions, 0) AS sessions
      FROM buckets
      LEFT JOIN o ON o.b = buckets.b
      LEFT JOIN e ON e.b = buckets.b
     ORDER BY buckets.b`,
    { unit, step: `1 ${unit}` }
  );
  return rows.map((r) => {
    const orders = toNumber(r.orders);
    const liveOrders = toNumber(r.live_orders);
    const sales = toNumber(r.sales);
    const sessions = toNumber(r.sessions);
    return {
      bucket: r.bucket,
      sales,
      deliveredSales: toNumber(r.delivered_sales),
      orders,
      sessions,
      averageOrderValue: liveOrders > 0 ? Math.round(sales / liveOrders) : 0,
      conversionRate: rate(orders, sessions),
    };
  });
}

async function salesBreakdowns(sql) {
  const { run, ORDERS, EVENTS, FIRSTS, BOUGHT } = sql;
  const [channels, devices, payments, heatmap] = await Promise.all([
    run(`
      WITH ev AS (${EVENTS}), ord AS (${ORDERS}), firsts AS (${FIRSTS}), bought AS (${BOUGHT})
      SELECT f.source, f.medium, count(DISTINCT f.sid) AS sessions,
             count(DISTINCT b.order_id) AS orders, coalesce(sum(b.total), 0) AS sales
        FROM firsts f LEFT JOIN bought b ON b.sid = f.sid
       GROUP BY f.source, f.medium
       ORDER BY sales DESC, sessions DESC, f.source
       LIMIT 12`),
    run(`
      WITH ev AS (${EVENTS}), ord AS (${ORDERS}), firsts AS (${FIRSTS}), bought AS (${BOUGHT})
      SELECT f.device, count(DISTINCT f.sid) AS sessions,
             count(DISTINCT b.order_id) AS orders, coalesce(sum(b.total), 0) AS sales
        FROM firsts f LEFT JOIN bought b ON b.sid = f.sid
       GROUP BY f.device
       ORDER BY sessions DESC, f.device`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT payment_method, count(*) AS orders, coalesce(sum(total), 0) AS sales
        FROM ord WHERE live GROUP BY 1 ORDER BY sales DESC, orders DESC`),
    // When orders come in: weekday (0 = Sunday) by hour, store time.
    run(`
      WITH ord AS (${ORDERS})
      SELECT extract(dow FROM created_at AT TIME ZONE :tz)::int AS dow,
             extract(hour FROM created_at AT TIME ZONE :tz)::int AS hour,
             count(*) AS orders
        FROM ord GROUP BY 1, 2`),
  ]);
  return {
    channels: channels.map((r) => ({
      source: r.source,
      medium: r.medium,
      sessions: toNumber(r.sessions),
      orders: toNumber(r.orders),
      sales: toNumber(r.sales),
      conversionRate: rate(toNumber(r.orders), toNumber(r.sessions)),
    })),
    devices: devices.map((r) => ({
      device: r.device,
      sessions: toNumber(r.sessions),
      orders: toNumber(r.orders),
      sales: toNumber(r.sales),
      conversionRate: rate(toNumber(r.orders), toNumber(r.sessions)),
    })),
    paymentMethods: payments.map((r) => ({ method: r.payment_method, orders: toNumber(r.orders), sales: toNumber(r.sales) })),
    heatmap: heatmap.map((r) => ({ dow: toNumber(r.dow), hour: toNumber(r.hour), orders: toNumber(r.orders) })),
  };
}

function withPrevious(current, previous) {
  const out = {};
  for (const [key, value] of Object.entries(current)) out[key] = { value, previous: previous ? previous[key] : null };
  return out;
}

function funnelSteps(f, previous) {
  const keys = ['sessions', 'product', 'cart', 'checkout', 'purchase'];
  return keys.map((step, i) => ({
    step,
    sessions: f[step],
    previous: previous ? previous[step] : null,
    rateOfSessions: rate(f[step], f.sessions),
    rateOfPrevious: i === 0 ? null : rate(f[step], f[keys[i - 1]]),
  }));
}

async function getSalesReport(workspaceId, query = {}) {
  const ctx = await context(workspaceId, query);
  const compare = query.compare || 'previous';
  const unit = UNITS.includes(query.unit) ? query.unit : autoUnit(ctx.window);
  const before = previousWindow(ctx.window, compare);
  const now = windowSql(workspaceId, ctx.window, ctx.tz);
  const prev = before ? windowSql(workspaceId, before, ctx.tz) : null;

  const [totals, series, breakdowns, prevTotals, prevSeries] = await Promise.all([
    salesTotals(now),
    salesSeries(now, unit),
    salesBreakdowns(now),
    prev ? salesTotals(prev) : null,
    prev ? salesSeries(prev, unit) : null,
  ]);

  return {
    range: { from: ctx.window.start, to: ctx.window.end, timeZone: ctx.tz },
    previousRange: before ? { from: before.start, to: before.end } : null,
    compare,
    unit,
    currency: ctx.currency,
    kpis: withPrevious(totals.kpis, prevTotals ? prevTotals.kpis : null),
    series,
    previousSeries: prevSeries,
    funnel: funnelSteps(totals.funnel, prevTotals ? prevTotals.funnel : null),
    ...breakdowns,
  };
}

async function getProductsReport(workspaceId, query = {}) {
  const ctx = await context(workspaceId, query);
  const { run, ORDERS, EVENTS, FIRSTS, BOUGHT } = windowSql(workspaceId, ctx.window, ctx.tz);
  const limit = Math.min(Number(query.limit) || 50, 200);
  const [products, landings] = await Promise.all([
    run(
      `
      WITH ord AS (${ORDERS}),
           ev AS (${EVENTS}),
           sold AS (
             SELECT i.product_id, max(i.product_name_snapshot) AS name,
                    count(DISTINCT ord.id) AS orders,
                    coalesce(sum(i.quantity), 0) AS units,
                    coalesce(sum(i.line_total_amount), 0) AS sales,
                    coalesce(sum(i.quantity) FILTER (WHERE ord.stage = 'delivered'), 0) AS delivered_units,
                    coalesce(sum(i.quantity) FILTER (WHERE ord.stage IN ('returned', 'delivery_failed')), 0) AS returned_units,
                    coalesce(sum(i.quantity) FILTER (WHERE ord.stage IN ${SHIPPED_STAGES}), 0) AS shipped_units,
                    coalesce(sum((i.line_total_amount - coalesce(i.unit_cost_amount, 0) * i.quantity)), 0) AS margin
               FROM ord JOIN order_items i ON i.order_id = ord.id
              WHERE ord.live AND i.product_id IS NOT NULL
              GROUP BY i.product_id),
           seen AS (
             SELECT pid::uuid AS product_id,
                    count(DISTINCT ev.sid) FILTER (WHERE ev.event_name = 'view_content') AS views,
                    count(DISTINCT ev.sid) FILTER (WHERE ev.event_name = 'add_to_cart') AS carts
               FROM ev
              CROSS JOIN LATERAL jsonb_array_elements_text(
                     CASE WHEN jsonb_typeof(ev.metadata->'productIds') = 'array' THEN ev.metadata->'productIds' ELSE '[]'::jsonb END) AS pid
              WHERE ev.event_name IN ('view_content', 'add_to_cart')
                AND pid ~ '^[0-9a-fA-F-]{36}$'
              GROUP BY 1)
      SELECT coalesce(sold.product_id, seen.product_id) AS product_id,
             coalesce(p.name, sold.name) AS name,
             coalesce(seen.views, 0) AS views, coalesce(seen.carts, 0) AS carts,
             coalesce(sold.orders, 0) AS orders, coalesce(sold.units, 0) AS units,
             coalesce(sold.sales, 0) AS sales, coalesce(sold.margin, 0) AS margin,
             coalesce(sold.delivered_units, 0) AS delivered_units,
             coalesce(sold.returned_units, 0) AS returned_units,
             coalesce(sold.shipped_units, 0) AS shipped_units
        FROM sold
        FULL JOIN seen ON seen.product_id = sold.product_id
        LEFT JOIN products p ON p.id = coalesce(sold.product_id, seen.product_id) AND p.workspace_id = :workspaceId
       WHERE coalesce(p.name, sold.name) IS NOT NULL
       ORDER BY sales DESC, views DESC
       LIMIT :limit`,
      { limit }
    ),
    run(
      `
      WITH ev AS (${EVENTS}), ord AS (${ORDERS}), firsts AS (${FIRSTS}), bought AS (${BOUGHT})
      SELECT f.landing AS path, count(DISTINCT f.sid) AS sessions,
             count(DISTINCT b.order_id) AS orders, coalesce(sum(b.total), 0) AS sales
        FROM firsts f LEFT JOIN bought b ON b.sid = f.sid
       GROUP BY f.landing
       ORDER BY sessions DESC, sales DESC
       LIMIT :limit`,
      { limit }
    ),
  ]);
  return {
    range: { from: ctx.window.start, to: ctx.window.end, timeZone: ctx.tz },
    currency: ctx.currency,
    products: products.map((r) => ({
      productId: r.product_id,
      name: r.name,
      views: toNumber(r.views),
      addToCarts: toNumber(r.carts),
      orders: toNumber(r.orders),
      units: toNumber(r.units),
      sales: toNumber(r.sales),
      margin: toNumber(r.margin),
      addToCartRate: rate(toNumber(r.carts), toNumber(r.views)),
      conversionRate: rate(toNumber(r.orders), toNumber(r.views)),
      deliveryRate: rate(toNumber(r.delivered_units), toNumber(r.shipped_units)),
      returnRate: rate(toNumber(r.returned_units), toNumber(r.shipped_units)),
    })),
    landingPages: landings.map((r) => ({
      path: r.path,
      sessions: toNumber(r.sessions),
      orders: toNumber(r.orders),
      sales: toNumber(r.sales),
      conversionRate: rate(toNumber(r.orders), toNumber(r.sessions)),
    })),
  };
}

async function getDeliveryReport(workspaceId, query = {}) {
  const ctx = await context(workspaceId, query);
  const { run, ORDERS } = windowSql(workspaceId, ctx.window, ctx.tz);
  const [[totals], stages, governorates, carriers, [timing]] = await Promise.all([
    run(`WITH ord AS (${ORDERS}) SELECT ${DELIVERY_AGG} FROM ord`),
    run(`WITH ord AS (${ORDERS}) SELECT stage, count(*) AS orders, coalesce(sum(total), 0) AS sales FROM ord GROUP BY 1`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT governorate AS name, ${DELIVERY_AGG}
        FROM ord WHERE governorate IS NOT NULL
       GROUP BY 1 ORDER BY orders DESC, sales DESC LIMIT 40`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT carrier AS name, ${DELIVERY_AGG},
             avg(extract(epoch FROM (delivered_at - shipped_at)) / 86400.0)
               FILTER (WHERE delivered_at IS NOT NULL AND shipped_at IS NOT NULL AND delivered_at >= shipped_at) AS delivery_days
        FROM ord WHERE carrier IS NOT NULL
       GROUP BY 1 ORDER BY orders DESC`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT avg(extract(epoch FROM (confirmed_at - created_at)) / 3600.0)
               FILTER (WHERE confirmed_at IS NOT NULL AND confirmed_at >= created_at) AS confirm_hours,
             avg(extract(epoch FROM (delivered_at - shipped_at)) / 86400.0)
               FILTER (WHERE delivered_at IS NOT NULL AND shipped_at IS NOT NULL AND delivered_at >= shipped_at) AS delivery_days
        FROM ord`),
  ]);
  const round1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
  return {
    range: { from: ctx.window.start, to: ctx.window.end, timeZone: ctx.tz },
    currency: ctx.currency,
    totals: delivery(totals),
    stages: stages.map((r) => ({ stage: r.stage, orders: toNumber(r.orders), sales: toNumber(r.sales) })),
    governorates: governorates.map((r) => ({ name: r.name, ...delivery(r) })),
    carriers: carriers.map((r) => ({ name: r.name, ...delivery(r), averageDeliveryDays: round1(r.delivery_days) })),
    averageConfirmationHours: round1(timing.confirm_hours),
    averageDeliveryDays: round1(timing.delivery_days),
  };
}

const COHORT_MONTHS = 6;

async function getCustomersReport(workspaceId, query = {}) {
  const ctx = await context(workspaceId, query);
  const { run, ORDERS } = windowSql(workspaceId, ctx.window, ctx.tz);
  const sale = countsAsSaleSql('o');
  // Every live order the store ever took, per customer — the lifetime view.
  const ALL = `
    SELECT o.customer_id, o.created_at, o.total_amount AS total
      FROM orders o
     WHERE o.workspace_id = :workspaceId AND o.customer_id IS NOT NULL AND ${sale}
       AND o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'`;
  const [[life], top, cohorts, [window]] = await Promise.all([
    run(`
      WITH al AS (${ALL}),
           c AS (SELECT customer_id, count(*) AS orders, sum(total) AS spent,
                        min(created_at) AS first_at, max(created_at) AS last_at FROM al GROUP BY 1),
           second AS (
             SELECT a.customer_id, min(a.created_at) AS second_at
               FROM al a JOIN c ON c.customer_id = a.customer_id
              WHERE a.created_at > c.first_at GROUP BY 1)
      SELECT count(*) AS customers,
             count(*) FILTER (WHERE c.orders >= 2) AS repeat_customers,
             coalesce(sum(c.orders), 0) AS orders,
             coalesce(sum(c.spent), 0) AS spent,
             avg(extract(epoch FROM (s.second_at - c.first_at)) / 86400.0) AS days_to_second
        FROM c LEFT JOIN second s ON s.customer_id = c.customer_id`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT ord.customer_id, cu.full_name AS name, count(*) AS orders, coalesce(sum(ord.total), 0) AS sales,
             count(*) FILTER (WHERE ord.stage = 'delivered') AS delivered
        FROM ord JOIN customers cu ON cu.id = ord.customer_id AND cu.workspace_id = :workspaceId
       WHERE ord.live
       GROUP BY ord.customer_id, cu.full_name
       ORDER BY sales DESC, orders DESC
       LIMIT 10`),
    // Monthly cohorts by first order: how many came back in each later month.
    run(
      `
      WITH al AS (${ALL}),
           firsts AS (SELECT customer_id, date_trunc('month', min(created_at) AT TIME ZONE :tz) AS cohort FROM al GROUP BY 1),
           active AS (
             SELECT DISTINCT a.customer_id, date_trunc('month', a.created_at AT TIME ZONE :tz) AS month FROM al a)
      SELECT to_char(f.cohort, 'YYYY-MM') AS cohort,
             ((extract(year FROM a.month) - extract(year FROM f.cohort)) * 12
               + extract(month FROM a.month) - extract(month FROM f.cohort))::int AS month_index,
             count(DISTINCT a.customer_id) AS customers
        FROM firsts f JOIN active a ON a.customer_id = f.customer_id
       WHERE f.cohort >= date_trunc('month', now() AT TIME ZONE :tz) - CAST(:cohortSpan AS interval)
       GROUP BY 1, 2
       ORDER BY 1, 2`,
      { cohortSpan: `${COHORT_MONTHS - 1} months` }
    ),
    run(`
      WITH ord AS (${ORDERS}),
           buyers AS (SELECT customer_id, count(*) AS orders, sum(total) FILTER (WHERE live) AS spent
                        FROM ord WHERE customer_id IS NOT NULL GROUP BY 1)
      SELECT count(*) FILTER (WHERE f.first_at >= :start) AS new_customers,
             count(*) FILTER (WHERE f.first_at < :start) AS returning_customers,
             coalesce(sum(b.orders) FILTER (WHERE f.first_at >= :start), 0) AS new_orders,
             coalesce(sum(b.orders) FILTER (WHERE f.first_at < :start), 0) AS returning_orders,
             coalesce(sum(b.spent) FILTER (WHERE f.first_at >= :start), 0) AS new_sales,
             coalesce(sum(b.spent) FILTER (WHERE f.first_at < :start), 0) AS returning_sales
        FROM buyers b
        JOIN LATERAL (
          SELECT min(x.created_at) AS first_at FROM orders x
           WHERE x.workspace_id = :workspaceId AND x.customer_id = b.customer_id
        ) f ON TRUE`),
  ]);

  const byCohort = new Map();
  for (const r of cohorts) {
    if (!byCohort.has(r.cohort)) byCohort.set(r.cohort, { cohort: r.cohort, size: 0, months: [] });
    const row = byCohort.get(r.cohort);
    const index = toNumber(r.month_index);
    if (index === 0) row.size = toNumber(r.customers);
    row.months[index] = toNumber(r.customers);
  }
  const customers = toNumber(life.customers);
  const newCustomers = toNumber(window.new_customers);
  const returningCustomers = toNumber(window.returning_customers);
  return {
    range: { from: ctx.window.start, to: ctx.window.end, timeZone: ctx.tz },
    currency: ctx.currency,
    window: {
      newCustomers,
      returningCustomers,
      returningCustomerRate: rate(returningCustomers, newCustomers + returningCustomers),
      newOrders: toNumber(window.new_orders),
      returningOrders: toNumber(window.returning_orders),
      newSales: toNumber(window.new_sales),
      returningSales: toNumber(window.returning_sales),
    },
    lifetime: {
      customers,
      repeatCustomers: toNumber(life.repeat_customers),
      repeatRate: rate(toNumber(life.repeat_customers), customers),
      averageOrders: customers > 0 ? Math.round((toNumber(life.orders) / customers) * 100) / 100 : 0,
      averageLifetimeValue: customers > 0 ? Math.round(toNumber(life.spent) / customers) : 0,
      averageDaysToSecondOrder:
        life.days_to_second === null || life.days_to_second === undefined ? null : Math.round(Number(life.days_to_second)),
    },
    // A customer who comes hidden is listed without a name (orders/orderLock); the CSV export reads this too.
    topCustomers: await orderLock.presentCustomers(
      workspaceId,
      top.map((r) => ({
        customerId: r.customer_id,
        name: r.name,
        orders: toNumber(r.orders),
        delivered: toNumber(r.delivered),
        sales: toNumber(r.sales),
      })),
      { pick: (r) => r.customerId, mask: (r) => orderLock.maskFields(r, ['name']) }
    ),
    cohorts: Array.from(byCohort.values()).map((row) => ({
      cohort: row.cohort,
      size: row.size,
      // Share of the cohort that ordered again in month 1, 2, … (month 0 is the cohort itself).
      retention: Array.from({ length: Math.max(row.months.length - 1, 0) }, (_, i) => rate(row.months[i + 1] || 0, row.size)),
    })),
  };
}

// --- Insights ---------------------------------------------------------------

const DAY_ORDER_MIN = 5;

/**
 * What the numbers say, as facts the dashboard words in the merchant's
 * language: each insight is `{ key, tone, params }`, never a sentence.
 */
async function getInsights(workspaceId, query = {}) {
  const [sales, deliveryReport, products] = await Promise.all([
    getSalesReport(workspaceId, { ...query, compare: 'previous' }),
    getDeliveryReport(workspaceId, query),
    getProductsReport(workspaceId, { ...query, limit: 100 }),
  ]);
  const insights = [];
  const k = sales.kpis;
  const change = (m) => (m.previous ? Math.round(((m.value - m.previous) / m.previous) * 100) : null);

  const salesChange = change(k.totalSales);
  if (salesChange !== null && Math.abs(salesChange) >= 10) {
    insights.push({
      key: salesChange > 0 ? 'sales_up' : 'sales_down',
      tone: salesChange > 0 ? 'good' : 'bad',
      params: { percent: Math.abs(salesChange), value: k.totalSales.value, previous: k.totalSales.previous },
    });
  }

  const conversionChange = change(k.conversionRate);
  if (conversionChange !== null && k.sessions.value >= 50 && Math.abs(conversionChange) >= 15) {
    insights.push({
      key: conversionChange > 0 ? 'conversion_up' : 'conversion_down',
      tone: conversionChange > 0 ? 'good' : 'bad',
      params: { percent: Math.abs(conversionChange), rate: k.conversionRate.value },
    });
  }

  // Where the funnel leaks most: the step that keeps the smallest share of the one before it.
  const leak = sales.funnel
    .filter((s, i) => i > 0 && sales.funnel[i - 1].sessions >= 20)
    .sort((a, b) => a.rateOfPrevious - b.rateOfPrevious)[0];
  if (leak && leak.rateOfPrevious < 50) {
    insights.push({ key: 'funnel_leak', tone: 'warn', params: { step: leak.step, rate: leak.rateOfPrevious } });
  }

  const total = deliveryReport.totals;
  if (total.codOrders >= 10 && total.confirmationRate < 60) {
    insights.push({ key: 'low_confirmation', tone: 'bad', params: { rate: total.confirmationRate, orders: total.codOrders } });
  }

  const shippedPlaces = deliveryReport.governorates.filter((g) => g.shipped >= DAY_ORDER_MIN);
  if (total.shipped >= 10 && shippedPlaces.length >= 2) {
    const worst = shippedPlaces.slice().sort((a, b) => a.deliveryRate - b.deliveryRate)[0];
    const best = shippedPlaces.slice().sort((a, b) => b.deliveryRate - a.deliveryRate)[0];
    if (total.deliveryRate - worst.deliveryRate >= 10) {
      insights.push({
        key: 'weak_governorate',
        tone: 'bad',
        params: { name: worst.name, rate: worst.deliveryRate, average: total.deliveryRate, orders: worst.shipped },
      });
    }
    if (best.name !== worst.name && best.deliveryRate - total.deliveryRate >= 10) {
      insights.push({
        key: 'strong_governorate',
        tone: 'good',
        params: { name: best.name, rate: best.deliveryRate, average: total.deliveryRate, orders: best.shipped },
      });
    }
  }

  const shippedCarriers = deliveryReport.carriers.filter((c) => c.shipped >= DAY_ORDER_MIN);
  if (shippedCarriers.length >= 2) {
    const sorted = shippedCarriers.slice().sort((a, b) => b.deliveryRate - a.deliveryRate);
    const [best, worst] = [sorted[0], sorted[sorted.length - 1]];
    if (best.deliveryRate - worst.deliveryRate >= 10) {
      insights.push({
        key: 'carrier_gap',
        tone: 'warn',
        params: { best: best.name, bestRate: best.deliveryRate, worst: worst.name, worstRate: worst.deliveryRate },
      });
    }
  }

  // A product many people look at and few buy.
  const viewed = products.products.filter((p) => p.views >= 30);
  if (viewed.length >= 2) {
    const views = viewed.reduce((sum, p) => sum + p.views, 0);
    const orders = viewed.reduce((sum, p) => sum + p.orders, 0);
    const average = rate(orders, views);
    const weak = viewed.filter((p) => p.conversionRate * 2 < average).sort((a, b) => b.views - a.views)[0];
    if (weak) {
      insights.push({
        key: 'low_converting_product',
        tone: 'warn',
        params: { name: weak.name, productId: weak.productId, views: weak.views, rate: weak.conversionRate, average },
      });
    }
  }

  const returned = products.products
    .filter((p) => p.units >= DAY_ORDER_MIN && p.returnRate >= 30)
    .sort((a, b) => b.returnRate - a.returnRate)[0];
  if (returned) {
    insights.push({
      key: 'high_return_product',
      tone: 'bad',
      params: { name: returned.name, productId: returned.productId, rate: returned.returnRate },
    });
  }

  if (k.uncontactedCheckouts.value > 0) {
    insights.push({
      key: 'abandoned_uncontacted',
      tone: 'warn',
      params: { count: k.uncontactedCheckouts.value, value: k.abandonedValue.value },
    });
  }

  const peak = sales.heatmap.slice().sort((a, b) => b.orders - a.orders)[0];
  if (peak && k.orders.value >= 20) {
    insights.push({ key: 'peak_time', tone: 'info', params: { dow: peak.dow, hour: peak.hour, orders: peak.orders } });
  }

  if (k.returningCustomers.value + k.newCustomers.value >= 10) {
    insights.push({
      key: 'returning_share',
      tone: 'info',
      params: { rate: k.returningCustomerRate.value, sales: k.returningCustomerSales.value },
    });
  }

  return { range: sales.range, currency: sales.currency, insights };
}

// --- CSV export -------------------------------------------------------------

const major = (minor) => (Number(minor) / 100).toFixed(2);
const percent = (value) => Number(value).toFixed(1);
const DELIVERY_COLUMNS = [
  ['orders', 'Orders'],
  ['confirmed', 'Confirmed'],
  ['shipped', 'Shipped'],
  ['delivered', 'Delivered'],
  ['returned', 'Returned'],
  ['confirmationRate', 'Confirmation rate %', percent],
  ['deliveryRate', 'Delivery rate %', percent],
  ['returnRate', 'Return rate %', percent],
  ['sales', 'Sales', major],
  ['deliveredSales', 'Delivered sales', major],
];

const EXPORTS = {
  sales: {
    load: getSalesReport,
    rows: (r) => r.series,
    columns: [
      ['bucket', 'Period'],
      ['sales', 'Total sales', major],
      ['deliveredSales', 'Delivered sales', major],
      ['orders', 'Orders'],
      ['averageOrderValue', 'Average order value', major],
      ['sessions', 'Sessions'],
      ['conversionRate', 'Conversion rate %', percent],
    ],
  },
  channels: {
    load: getSalesReport,
    rows: (r) => r.channels,
    columns: [
      ['source', 'Source'],
      ['medium', 'Medium'],
      ['sessions', 'Sessions'],
      ['orders', 'Orders'],
      ['sales', 'Sales', major],
      ['conversionRate', 'Conversion rate %', percent],
    ],
  },
  products: {
    load: (ws, q) => getProductsReport(ws, { ...q, limit: 200 }),
    rows: (r) => r.products,
    columns: [
      ['name', 'Product'],
      ['views', 'Sessions that viewed'],
      ['addToCarts', 'Added to cart'],
      ['orders', 'Orders'],
      ['units', 'Units'],
      ['sales', 'Sales', major],
      ['conversionRate', 'Conversion rate %', percent],
      ['deliveryRate', 'Delivery rate %', percent],
      ['returnRate', 'Return rate %', percent],
    ],
  },
  landing_pages: {
    load: (ws, q) => getProductsReport(ws, { ...q, limit: 200 }),
    rows: (r) => r.landingPages,
    columns: [
      ['path', 'Landing page'],
      ['sessions', 'Sessions'],
      ['orders', 'Orders'],
      ['sales', 'Sales', major],
      ['conversionRate', 'Conversion rate %', percent],
    ],
  },
  governorates: { load: getDeliveryReport, rows: (r) => r.governorates, columns: [['name', 'Governorate'], ...DELIVERY_COLUMNS] },
  carriers: { load: getDeliveryReport, rows: (r) => r.carriers, columns: [['name', 'Courier'], ...DELIVERY_COLUMNS] },
  customers: {
    load: getCustomersReport,
    rows: (r) => r.topCustomers,
    columns: [
      ['name', 'Customer'],
      ['orders', 'Orders'],
      ['delivered', 'Delivered'],
      ['sales', 'Sales', major],
    ],
  },
};

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // A cell a spreadsheet would run as a formula is neutralised.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportReport(workspaceId, query = {}) {
  const spec = EXPORTS[query.report];
  if (!spec) throw new ValidationError([{ field: 'report', message: 'unknown report' }], 'Invalid query');
  const report = await spec.load(workspaceId, query);
  const lines = [spec.columns.map(([, title]) => csvCell(title)).join(',')];
  for (const row of spec.rows(report)) {
    lines.push(spec.columns.map(([key, , format]) => csvCell(format ? format(row[key]) : row[key])).join(','));
  }
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  return {
    filename: `zimos-${query.report}-${day(report.range.from)}-${day(report.range.to)}.csv`,
    // The BOM makes Excel read Arabic names as UTF-8.
    body: `﻿${lines.join('\r\n')}\r\n`,
  };
}

module.exports = {
  getSalesReport,
  getProductsReport,
  getDeliveryReport,
  getCustomersReport,
  getInsights,
  exportReport,
  EXPORT_REPORTS: Object.keys(EXPORTS),
  UNITS,
};
