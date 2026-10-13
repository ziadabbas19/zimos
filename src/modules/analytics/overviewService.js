'use strict';

const db = require('../../db/models');
const { ValidationError } = require('../../core/errors/AppError');
const { STAGE_SQL, LATEST_SHIPMENT_JOIN, countsAsSaleSql } = require('../orders/orderStage');
const { dayKey, rate, toNumber, DAY_MS } = require('./analyticsService');
const base = require('../currencies/baseAmounts');

/**
 * The dashboard home in one request (SPEC §15.1): every KPI for a range and
 * for the range before it, a per-day series for the sparklines, the
 * conversion funnel, the offers table and the "top" lists.
 *
 * Everything is aggregated in Postgres over indexed columns; nothing is
 * loaded into the API process. Definitions, so the numbers can be explained
 * to a merchant:
 *
 *   orders            placed orders that count as a sale (a prepaid order that
 *                     was never paid is an abandoned payment, not an order),
 *                     test orders excluded
 *   sales             totalAmount of those orders that are not cancelled
 *   AOV               sales ÷ orders that are not cancelled
 *   confirmation rate confirmed COD orders ÷ COD orders (only COD has a call)
 *   delivery rate     delivered ÷ orders that left with a courier
 *   conversion rate   orders ÷ visits
 *   lost rate         abandoned checkouts ÷ visits
 */

const MAX_RANGE_DAYS = 366;
const DEFAULT_DAYS = 7;
const SHIPPED_STAGES = "('shipped', 'out_for_delivery', 'delivery_failed', 'delivered', 'returned')";

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

/** Columns other modules add to `orders`; used when present, ignored until then. */
function orderColumns() {
  const attrs = db.Order.rawAttributes;
  return {
    notTest: attrs.isTest ? `AND o.${attrs.isTest.field || 'is_test'} = false` : '',
    unseen: attrs.isSeen ? `o.${attrs.isSeen.field || 'is_seen'} = false` : null,
  };
}

/** Every number of one window, plus its per-day rows. */
async function collectWindow(workspaceId, { start, end, tz, funnelId }) {
  const cols = orderColumns();
  const replacements = { workspaceId, start, end, tz, funnelId: funnelId || null };
  const run = (sql) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
  const orderFunnel = funnelId ? 'AND o.funnel_id = :funnelId' : '';
  const eventFunnel = funnelId ? 'AND e.funnel_id = :funnelId' : '';
  const sale = countsAsSaleSql('o');
  const live = "(o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected')";

  const ORDERS = `
    SELECT o.id, o.customer_id, o.created_at, ${base.totalSql('o')} AS total_amount, ${base.amountSql('discount_amount')} AS discount_amount, ${base.amountSql('amount_refunded')} AS amount_refunded,
           o.payment_method, o.confirmation_state, o.funnel_id, o.shipping_address_snapshot,
           ${live} AS live, ${STAGE_SQL} AS stage,
           ${cols.unseen || "(o.confirmation_state = 'pending' AND o.cancelled_at IS NULL)"} AS is_new,
           to_char(o.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day
      FROM orders o${LATEST_SHIPMENT_JOIN}
     WHERE o.workspace_id = :workspaceId AND o.created_at >= :start AND o.created_at < :end
       AND ${sale} ${cols.notTest} ${orderFunnel}`;

  const EVENTS = `
    SELECT coalesce(e.session_id, e.visitor_id) AS sid, e.event_name, e.metadata, e.created_at,
           to_char(e.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day
      FROM analytics_events e
     WHERE e.workspace_id = :workspaceId AND e.created_at >= :start AND e.created_at < :end ${eventFunnel}`;

  const ORDER_AGG = `
      count(*) AS orders,
      count(*) FILTER (WHERE live) AS live_orders,
      coalesce(sum(total_amount) FILTER (WHERE live), 0) AS sales,
      count(*) FILTER (WHERE is_new) AS new_orders,
      count(*) FILTER (WHERE payment_method = 'cod') AS cod_orders,
      count(*) FILTER (WHERE payment_method = 'cod' AND confirmation_state = 'confirmed') AS confirmed,
      count(*) FILTER (WHERE stage IN ${SHIPPED_STAGES}) AS shipped,
      count(*) FILTER (WHERE stage = 'delivered') AS delivered`;
  // A funnel checkout stores its funnel in the session's attribution.
  const lostFunnel = funnelId ? "AND c.attribution->>'funnelId' = :funnelId" : '';
  const LOST = `
    SELECT to_char(c.created_at AT TIME ZONE :tz, 'YYYY-MM-DD') AS day
      FROM checkout_sessions c
     WHERE c.workspace_id = :workspaceId AND c.created_at >= :start AND c.created_at < :end
       AND c.status = 'abandoned' ${lostFunnel}`;

  // Event numbers: whole days from analytics_daily, the edges from raw events (analyticsDaily.js).
  const events = require('./analyticsDaily').eventNumbers(workspaceId, { start, end, tz, funnelId });
  const [[orderTotals], orderDays, [eventTotals], eventDays, lostDays, [customers], [profit]] = await Promise.all([
    run(`WITH ord AS (${ORDERS}) SELECT ${ORDER_AGG} FROM ord`),
    run(`WITH ord AS (${ORDERS}) SELECT day, ${ORDER_AGG} FROM ord GROUP BY day`),
    events.then((e) => [e.total]),
    events.then((e) => e.days),
    run(`WITH lost AS (${LOST}) SELECT day, count(*) AS lost FROM lost GROUP BY day`),
    // New = the customer's first ever order falls inside the window.
    run(`
      WITH ord AS (${ORDERS}),
           buyers AS (SELECT DISTINCT customer_id FROM ord)
      SELECT count(*) FILTER (WHERE f.first_at >= :start) AS new_customers,
             count(*) FILTER (WHERE f.first_at < :start) AS returning_customers
        FROM buyers b
        JOIN LATERAL (
          SELECT min(x.created_at) AS first_at FROM orders x
           WHERE x.workspace_id = :workspaceId AND x.customer_id = b.customer_id
        ) f ON TRUE`),
    // Delivered item revenue − discounts − cost of goods − refunds. Replaced by
    // the full P&L (pnlService) once it is present.
    run(`
      WITH ord AS (${ORDERS})
      SELECT coalesce(sum(i.line_total_amount), 0) AS items_revenue,
             coalesce(sum(coalesce(i.unit_cost_amount, 0) * i.quantity), 0) AS cost,
             (SELECT coalesce(sum(discount_amount + amount_refunded), 0) FROM ord WHERE stage = 'delivered') AS deductions
        FROM ord JOIN order_items i ON i.order_id = ord.id
       WHERE ord.stage = 'delivered'`),
  ]);

  const days = new Map();
  const blank = (date) => ({
    date, visits: 0, orders: 0, sales: 0, addToCart: 0, checkouts: 0, crossSell: 0, lost: 0, leads: 0,
    confirmed: 0, delivered: 0,
  });
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    const key = dayKey(new Date(t), tz);
    days.set(key, blank(key));
  }
  const lastKey = dayKey(new Date(end.getTime() - 1), tz);
  if (!days.has(lastKey)) days.set(lastKey, blank(lastKey));
  const at = (key) => {
    if (!days.has(key)) days.set(key, blank(key));
    return days.get(key);
  };
  for (const r of orderDays) {
    const d = at(r.day);
    d.orders = toNumber(r.orders);
    d.sales = toNumber(r.sales);
    d.confirmed = toNumber(r.confirmed);
    d.delivered = toNumber(r.delivered);
  }
  for (const r of eventDays) {
    const d = at(r.day);
    d.visits = toNumber(r.visits);
    d.addToCart = toNumber(r.add_to_cart);
    d.checkouts = toNumber(r.checkouts);
    d.crossSell = toNumber(r.cross_sell);
    d.leads = toNumber(r.leads);
  }
  let lost = 0;
  for (const r of lostDays) {
    at(r.day).lost = toNumber(r.lost);
    lost += toNumber(r.lost);
  }

  const orders = toNumber(orderTotals.orders);
  const liveOrders = toNumber(orderTotals.live_orders);
  const sales = toNumber(orderTotals.sales);
  const visits = toNumber(eventTotals.visits);
  return {
    totals: {
      visits,
      orders,
      sales,
      averageOrderValue: liveOrders > 0 ? Math.round(sales / liveOrders) : 0,
      addToCart: toNumber(eventTotals.add_to_cart),
      checkouts: toNumber(eventTotals.checkouts),
      crossSellAdds: toNumber(eventTotals.cross_sell),
      newOrders: toNumber(orderTotals.new_orders),
      lostOrders: lost,
      conversionRate: rate(orders, visits),
      lostRate: rate(lost, visits),
      netProfit: toNumber(profit.items_revenue) - toNumber(profit.cost) - toNumber(profit.deductions),
      newCustomers: toNumber(customers.new_customers),
      returningCustomers: toNumber(customers.returning_customers),
      leads: toNumber(eventTotals.leads),
      confirmationRate: rate(toNumber(orderTotals.confirmed), toNumber(orderTotals.cod_orders)),
      deliveryRate: rate(toNumber(orderTotals.delivered), toNumber(orderTotals.shipped)),
    },
    funnelSessions: {
      visits,
      cart: toNumber(eventTotals.cart_sessions),
      checkout: toNumber(eventTotals.checkout_sessions),
      purchase: toNumber(eventTotals.purchase_sessions),
    },
    series: Array.from(days.values()).sort((a, b) => (a.date < b.date ? -1 : 1)),
    sql: { ORDERS, EVENTS, run },
  };
}

/** The lists under the cards — for the current window only. */
async function collectBreakdowns({ ORDERS, EVENTS, run }) {
  const FIRSTS = `
    SELECT DISTINCT ON (e.sid) e.sid,
           coalesce(nullif(x.source, ''), nullif(x.referrer_domain, ''), 'direct') AS source,
           nullif(x.medium, '') AS medium,
           coalesce(nullif(s.device, ''), nullif(x.metadata->>'device', ''), 'unknown') AS device
      FROM ev e
      JOIN analytics_events x ON x.workspace_id = :workspaceId
       AND coalesce(x.session_id, x.visitor_id) = e.sid AND x.created_at = e.created_at
      LEFT JOIN analytics_sessions s ON s.id = x.session_id AND s.workspace_id = x.workspace_id
     ORDER BY e.sid, e.created_at`;
  const [offers, sources, governorates, devices, products, funnels] = await Promise.all([
    run(`
      WITH ord AS (${ORDERS})
      SELECT CASE WHEN i.is_upsell THEN 'upsell' WHEN i.is_order_bump THEN 'bump' ELSE 'bundle' END AS type,
             count(DISTINCT ord.id) AS orders, coalesce(sum(i.quantity), 0) AS quantity,
             coalesce(sum(i.line_total_amount), 0) AS total
        FROM ord JOIN order_items i ON i.order_id = ord.id
       WHERE ord.live AND (i.is_upsell OR i.is_order_bump OR i.offer_id IS NOT NULL)
       GROUP BY 1`),
    run(`
      WITH ev AS (${EVENTS}), firsts AS (${FIRSTS}),
           bought AS (
             SELECT DISTINCT coalesce(p.session_id, p.visitor_id) AS sid, p.order_id
               FROM analytics_events p
              WHERE p.workspace_id = :workspaceId AND p.created_at >= :start AND p.created_at < :end
                AND p.event_name = 'purchase' AND p.order_id IS NOT NULL)
      SELECT f.source, f.medium, count(DISTINCT f.sid) AS visits,
             count(DISTINCT b.order_id) AS orders,
             coalesce(sum(t.total), 0) AS sales
        FROM firsts f
        LEFT JOIN bought b ON b.sid = f.sid
        LEFT JOIN LATERAL (
          SELECT o.total_amount AS total FROM orders o
           WHERE o.id = b.order_id AND o.workspace_id = :workspaceId AND o.cancelled_at IS NULL
             AND o.confirmation_state <> 'rejected'
        ) t ON TRUE
       GROUP BY f.source, f.medium
       ORDER BY visits DESC, orders DESC, f.source
       LIMIT 8`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT coalesce(nullif(shipping_address_snapshot->>'governorate', ''), nullif(shipping_address_snapshot->>'city', '')) AS name,
             count(*) AS orders, coalesce(sum(total_amount), 0) AS sales
        FROM ord
       WHERE live
       GROUP BY 1
      HAVING coalesce(nullif(shipping_address_snapshot->>'governorate', ''), nullif(shipping_address_snapshot->>'city', '')) IS NOT NULL
       ORDER BY orders DESC, sales DESC
       LIMIT 8`),
    run(`
      WITH ev AS (${EVENTS}), firsts AS (${FIRSTS})
      SELECT device, count(*) AS visits FROM firsts GROUP BY device ORDER BY visits DESC, device`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT i.product_id, max(i.product_name_snapshot) AS name,
             coalesce(sum(i.quantity), 0) AS quantity, coalesce(sum(i.line_total_amount), 0) AS sales
        FROM ord JOIN order_items i ON i.order_id = ord.id
       WHERE ord.live
       GROUP BY coalesce(i.product_id::text, i.product_name_snapshot), i.product_id
       ORDER BY quantity DESC, sales DESC
       LIMIT 8`),
    run(`
      WITH ord AS (${ORDERS})
      SELECT f.id, f.name, count(*) AS orders, coalesce(sum(ord.total_amount), 0) AS sales
        -- This store's funnels only: an order naming a funnel id of another
        -- store shows no funnel row (it still counts in the totals above).
        FROM ord JOIN funnels f ON f.id = ord.funnel_id AND f.workspace_id = :workspaceId
       WHERE ord.live
       GROUP BY f.id, f.name
       ORDER BY sales DESC, orders DESC
       LIMIT 8`),
  ]);
  const byType = new Map(offers.map((r) => [r.type, r]));
  return {
    offers: ['bundle', 'bump', 'upsell'].map((type) => {
      const r = byType.get(type) || {};
      return { type, orders: toNumber(r.orders), quantity: toNumber(r.quantity), total: toNumber(r.total) };
    }),
    topSources: sources.map((r) => ({
      source: r.source, medium: r.medium, visits: toNumber(r.visits), orders: toNumber(r.orders), sales: toNumber(r.sales),
    })),
    topGovernorates: governorates.map((r) => ({ name: r.name, orders: toNumber(r.orders), sales: toNumber(r.sales) })),
    devices: devices.map((r) => ({ device: r.device, visits: toNumber(r.visits) })),
    topProducts: products.map((r) => ({
      productId: r.product_id, name: r.name, quantity: toNumber(r.quantity), sales: toNumber(r.sales),
    })),
    topFunnels: funnels.map((r) => ({ funnelId: r.id, name: r.name, orders: toNumber(r.orders), sales: toNumber(r.sales) })),
  };
}

const MONEY_METRICS = ['sales', 'averageOrderValue', 'netProfit'];

async function getOverview(workspaceId, query = {}) {
  const { start, end } = resolveWindow(query);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  const tz = validTimeZone((workspace && workspace.timezone) || 'UTC');
  const funnelId = query.funnelId || null;
  if (funnelId) {
    const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['id'] });
    if (!funnel) throw new ValidationError([{ field: 'funnelId', message: 'unknown funnel' }], 'Invalid query');
  }
  const compare = query.compare !== 'none';
  const span = end.getTime() - start.getTime();
  const previousWindow = { start: new Date(start.getTime() - span), end: start };

  const [current, previous] = await Promise.all([
    collectWindow(workspaceId, { start, end, tz, funnelId }),
    compare ? collectWindow(workspaceId, { ...previousWindow, tz, funnelId }) : Promise.resolve(null),
  ]);
  const breakdowns = await collectBreakdowns(current.sql);

  // Net profit is the real one (modules/profit): delivered revenue after goods,
  // both shipping legs, fees and ad spend. The P&L has no funnel split, so a
  // funnel-filtered overview keeps the simple estimate computed above.
  if (!funnelId) {
    const { getPnl } = require('../profit/pnlService');
    const [now, before] = await Promise.all([
      getPnl(workspaceId, { from: start, to: end }),
      compare ? getPnl(workspaceId, { from: previousWindow.start, to: previousWindow.end }) : Promise.resolve(null),
    ]);
    current.totals.netProfit = now.totals.actual.netProfit;
    if (previous && before) previous.totals.netProfit = before.totals.actual.netProfit;
  }

  const metrics = {};
  for (const [key, value] of Object.entries(current.totals)) {
    metrics[key] = { value, previous: previous ? previous.totals[key] : null };
  }
  const f = current.funnelSessions;
  const funnel = [
    { step: 'visits', sessions: f.visits },
    { step: 'cart', sessions: f.cart },
    { step: 'checkout', sessions: f.checkout },
    { step: 'purchase', sessions: f.purchase },
  ].map((row, i, all) => ({
    ...row,
    rateOfVisits: rate(row.sessions, f.visits),
    rateOfPrevious: i === 0 ? null : rate(row.sessions, all[i - 1].sessions),
  }));

  const baseCurrency = (workspace && workspace.defaultCurrency) || 'EGP';
  const currency = baseCurrency;

  return {
    range: { from: start.toISOString(), to: end.toISOString(), timeZone: tz },
    previousRange: compare
      ? { from: previousWindow.start.toISOString(), to: previousWindow.end.toISOString() }
      : null,
    funnelId,
    currency,
    baseCurrency,
    moneyMetrics: MONEY_METRICS,
    metrics,
    series: current.series,
    funnel,
    ...breakdowns,
  };
}

module.exports = { getOverview, resolveWindow, collectWindow, collectBreakdowns };
