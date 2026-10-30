'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const base = require('../currencies/baseAmounts');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

const toNumber = (v) => (v === null || v === undefined ? 0 : Number(v));

// One formatter per time zone: building one costs ~0.1ms, and the summary
// names the day of every order in its range (10,000 orders, a second). Kept
// small: a zone name is case-insensitive, so the spellings of one are many.
const dayFormats = new Map();
const MAX_DAY_FORMATS = 64;

function dayFormat(timeZone) {
  if (dayFormats.has(timeZone)) return dayFormats.get(timeZone);
  let format = null;
  try {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    // An unknown zone: the UTC day below, as before.
  }
  if (dayFormats.size >= MAX_DAY_FORMATS) dayFormats.clear();
  dayFormats.set(timeZone, format);
  return format;
}

/** YYYY-MM-DD in the workspace's timezone, so "today" matches the merchant's day. */
function dayKey(date, timeZone) {
  try {
    const format = dayFormat(timeZone);
    if (format) return format.format(date);
  } catch {
    // Falls through to the UTC day.
  }
  return date.toISOString().slice(0, 10);
}

function resolveRange({ from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  let start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY_MS);
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) start = new Date(end.getTime() - MAX_RANGE_DAYS * DAY_MS);
  return { start, end };
}

const rate = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

const DEVICES = ['mobile', 'desktop', 'tablet'];

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * Storefront traffic for a range, from analytics_events (written by
 * POST /store/:workspaceId/events). A session is attributed to the device and
 * source of its first event in the range; purchases count distinct orders.
 * The conversion rate is purchases ÷ sessions — sessions that converted, the
 * way Shopify defines it — so orders that predate the tracker (or came in by
 * phone) never push it past 100%.
 * Also fills `sessions` on each day of `series` (by a session's first event).
 *
 * Aggregated in Postgres rather than in Node: a year of a busy store's events
 * is millions of rows, which must never be loaded into the API process.
 *
 * One statement that reads the range's events once. The sessions are grouped
 * by hashing, not counted with count(distinct), which sorts every event once
 * per count; a session's first event is looked for only among the events at
 * its start. (Five statements, each reading and sorting the events again,
 * took twice as long on 30 days of a busy store.)
 */
async function getTraffic(workspaceId, { start, end, timeZone, series }) {
  const [answer] = await db.sequelize.query(
    `
    with ev as materialized (
      -- Every event in range, with the key that groups it into a session
      -- (never null: visitor_id is required).
      select coalesce(e.session_id, e.visitor_id) as sid, e.visitor_id, e.event_name, e.source, e.medium,
             e.order_id, e.metadata->>'device' as device, e.metadata->>'path' as path, e.created_at, e.id
      from analytics_events e
      where e.workspace_id = :workspaceId and e.created_at >= :start and e.created_at < :end),
    sessions as materialized (
      select sid, min(created_at) as started_at,
             bool_or(event_name = 'add_to_cart') as carted,
             bool_or(event_name = 'begin_checkout') as checked_out
      from ev
      group by sid),
    firsts as materialized (
      -- One row per session: what its first event (by time, then id) says about it.
      select distinct on (ev.sid) ev.sid,
             case when ev.device in (:devices) then ev.device else 'unknown' end as device,
             coalesce(nullif(ev.source, ''), 'direct') as source,
             nullif(ev.medium, '') as medium,
             to_char(ev.created_at at time zone :tz, 'YYYY-MM-DD') as day
      from sessions s
      join ev on ev.sid = s.sid and ev.created_at = s.started_at
      order by ev.sid, ev.id),
    counts as (
      select
        count(*) filter (where event_name = 'page_view') as page_views,
        count(*) filter (where event_name = 'view_content') as product_views,
        count(*) filter (where event_name = 'purchase' and order_id is null) as purchases_without_order
      from ev)
    select
      (select row_to_json(t) from (
        select
          (select count(*) from sessions) as sessions,
          (select count(*) from (select visitor_id from ev group by visitor_id) v) as visitors,
          c.page_views,
          c.product_views,
          (select count(*) from sessions where carted) as add_to_cart,
          (select count(*) from sessions where checked_out) as checkouts,
          (select count(*) from (
            select order_id from ev where event_name = 'purchase' and order_id is not null group by order_id) o) as purchase_orders,
          c.purchases_without_order
        from counts c) t) as totals,
      (select coalesce(json_agg(d order by d.sessions desc, d.device), '[]'::json) from (
        select device, count(*) as sessions from firsts group by device) d) as by_device,
      (select coalesce(json_agg(s order by s.sessions desc, s.orders desc, s.source), '[]'::json) from (
        select f.source, f.medium, count(distinct f.sid) as sessions, count(distinct p.order_id) as orders
        from firsts f
        left join ev p on p.sid = f.sid and p.event_name = 'purchase' and p.order_id is not null
        group by f.source, f.medium
        order by sessions desc, orders desc, f.source
        limit 10) s) as by_source,
      (select coalesce(json_agg(p order by p.views desc, p.path), '[]'::json) from (
        select path, count(*) as views from ev
        where event_name = 'page_view' and coalesce(path, '') <> ''
        group by 1
        order by views desc, path
        limit 10) p) as top_pages,
      (select coalesce(json_agg(y), '[]'::json) from (
        select day, count(*) as sessions from firsts group by day) y) as by_day`,
    {
      replacements: { workspaceId, start, end, tz: validTimeZone(timeZone), devices: DEVICES },
      type: db.Sequelize.QueryTypes.SELECT,
    }
  );
  const { totals, by_device: byDevice, by_source: bySource, top_pages: topPages, by_day: byDay } = answer;

  for (const row of byDay) {
    const day = series.get(row.day);
    if (day) day.sessions += toNumber(row.sessions);
  }

  const sessionCount = toNumber(totals.sessions);
  const purchaseOrders = toNumber(totals.purchase_orders);
  const purchases = purchaseOrders > 0 ? purchaseOrders : toNumber(totals.purchases_without_order);
  const addToCart = toNumber(totals.add_to_cart);
  const checkouts = toNumber(totals.checkouts);
  return {
    sessions: sessionCount,
    visitors: toNumber(totals.visitors),
    pageViews: toNumber(totals.page_views),
    productViews: toNumber(totals.product_views),
    addToCart,
    checkouts,
    purchases,
    conversionRate: rate(purchases, sessionCount),
    addToCartRate: rate(addToCart, sessionCount),
    checkoutRate: rate(checkouts, sessionCount),
    byDevice: byDevice.map((r) => ({ device: r.device, sessions: toNumber(r.sessions) })),
    bySource: bySource.map((r) => ({
      source: r.source,
      medium: r.medium,
      sessions: toNumber(r.sessions),
      orders: toNumber(r.orders),
    })),
    topPages: topPages.map((r) => ({ path: r.path, views: toNumber(r.views) })),
  };
}

/**
 * Store performance for a date range, computed only from real orders.
 *
 * - "Placed" excludes nothing; "active" excludes cancelled and rejected orders.
 * - Delivered revenue counts orders whose fulfillmentState is `fulfilled`.
 * - Profit uses the cost snapshot stored on each order item; `costCoverage`
 *   tells the merchant how much of the delivered quantity had a cost set, so
 *   the number is never presented as more complete than it is. Shipping fees
 *   charged to the customer are reported separately (courier cost is unknown).
 */
async function getSummary(workspaceId, query = {}) {
  const { start, end } = resolveRange(query);
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency', 'timezone'] });
  const timeZone = (workspace && workspace.timezone) || 'UTC';

  const orders = await db.Order.findAll({
    where: { workspaceId, createdAt: { [Op.gte]: start, [Op.lt]: end } },
    attributes: [
      'id', 'createdAt', 'currency', 'confirmationState', 'fulfillmentState', 'financialState', 'cancelledAt',
      'subtotalAmount', 'discountAmount', 'shippingAmount', 'totalAmount', 'amountPaid', 'amountRefunded',
    ],
    include: [
      {
        model: db.OrderItem,
        as: 'items',
        attributes: ['productId', 'productNameSnapshot', 'quantity', 'unitCostAmount', 'lineTotalAmount'],
      },
    ],
    order: [['createdAt', 'ASC']],
  });

  const counts = { placed: 0, pending: 0, confirmed: 0, rejected: 0, unreachable: 0, postponed: 0, cancelled: 0, delivered: 0, returned: 0 };
  const revenue = { gross: 0, delivered: 0, collected: 0, refunded: 0, shippingCharged: 0, discounts: 0 };
  const profit = { productCost: 0, deliveredItemsRevenue: 0, costedQuantity: 0, deliveredQuantity: 0 };
  const series = new Map();
  const products = new Map();

  // Pre-fill every day so charts have a continuous axis.
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    series.set(dayKey(new Date(t), timeZone), { date: dayKey(new Date(t), timeZone), orders: 0, revenue: 0, delivered: 0, sessions: 0 });
  }

  for (const o of orders) {
    const cancelled = Boolean(o.cancelledAt);
    const active = !cancelled && o.confirmationState !== 'rejected';
    // Every amount in the store's base currency (currencies/baseAmounts.js).
    const total = base.total(o);
    counts.placed += 1;
    if (cancelled) counts.cancelled += 1;
    else counts[o.confirmationState] = (counts[o.confirmationState] || 0) + 1;
    if (o.fulfillmentState === 'fulfilled') counts.delivered += 1;
    if (o.fulfillmentState === 'returned') counts.returned += 1;

    revenue.collected += base.amount(o, o.amountPaid);
    revenue.refunded += base.amount(o, o.amountRefunded);

    const key = dayKey(o.createdAt, timeZone);
    const day = series.get(key) || { date: key, orders: 0, revenue: 0, delivered: 0, sessions: 0 };
    day.orders += 1;

    if (active) {
      revenue.gross += total;
      day.revenue += total;
      for (const item of o.items || []) {
        const id = item.productId || item.productNameSnapshot;
        const p = products.get(id) || { productId: item.productId, name: item.productNameSnapshot, quantity: 0, revenue: 0 };
        p.quantity += item.quantity;
        p.revenue += base.amount(o, item.lineTotalAmount);
        products.set(id, p);
      }
    }

    if (o.fulfillmentState === 'fulfilled') {
      revenue.delivered += total;
      revenue.shippingCharged += base.amount(o, o.shippingAmount);
      revenue.discounts += base.amount(o, o.discountAmount);
      day.delivered += 1;
      for (const item of o.items || []) {
        profit.deliveredQuantity += item.quantity;
        profit.deliveredItemsRevenue += base.amount(o, item.lineTotalAmount);
        if (item.unitCostAmount !== null && item.unitCostAmount !== undefined) {
          profit.productCost += toNumber(item.unitCostAmount) * item.quantity;
          profit.costedQuantity += item.quantity;
        }
      }
    }
    series.set(key, day);
  }

  const activeCount = counts.placed - counts.cancelled - counts.rejected;
  const decided = counts.confirmed + counts.rejected + counts.unreachable;
  const grossProfit = profit.deliveredItemsRevenue - revenue.discounts - profit.productCost - revenue.refunded;

  // Mutates `series` (adds per-day sessions), so it runs before the array is built.
  const traffic = await getTraffic(workspaceId, { start, end, timeZone, series });

  return {
    range: { from: start.toISOString(), to: end.toISOString(), timeZone },
    currency: (workspace && workspace.defaultCurrency) || (orders[0] && orders[0].currency) || 'EGP',
    orders: counts,
    rates: {
      confirmation: rate(counts.confirmed, decided),
      delivery: rate(counts.delivered, counts.confirmed),
      return: rate(counts.returned, counts.delivered + counts.returned),
    },
    revenue: { ...revenue, averageOrderValue: activeCount > 0 ? Math.round(revenue.gross / activeCount) : 0 },
    profit: {
      deliveredItemsRevenue: profit.deliveredItemsRevenue,
      discounts: revenue.discounts,
      productCost: profit.productCost,
      refunded: revenue.refunded,
      grossProfit,
      costCoverage: rate(profit.costedQuantity, profit.deliveredQuantity),
    },
    series: Array.from(series.values()),
    topProducts: Array.from(products.values()).sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, 5),
    newCustomers: await db.Customer.count({ where: { workspaceId, createdAt: { [Op.gte]: start, [Op.lt]: end } } }),
    traffic,
  };
}

module.exports = { getSummary, getTraffic, resolveRange, dayKey, rate, toNumber, DAY_MS };
