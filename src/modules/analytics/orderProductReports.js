'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { ValidationError, NotFoundError } = require('../../core/errors/AppError');
const { STAGES, STAGE_SQL, countsAsSaleSql } = require('../orders/orderStage');
const orderLock = require('../orders/orderLock');
const { rate, toNumber } = require('./analyticsService');
const { previousWindow, autoUnit, context, csvCell, SHIPPED_STAGES, SHIPMENT_JOIN } = require('./reportsService');

/**
 * The orders report and the products report (STORE_FEATURES
 * order_product_reports): the numbers behind a date range, aggregated in
 * Postgres, one request each.
 *
 * Which orders: the ones the Orders page lists for those dates — placed in
 * the range, not archived (archiving is how a merchant deletes an order),
 * test orders left out — each under its stage from orders/orderStage.js, the
 * same expression as the Orders page's tabs, so the counts match them.
 *
 *   orders             every one of those orders
 *   revenue            the total of the ones that stand as a sale: not cancelled
 *                      or rejected, and not a prepaid order never paid
 *                      (countsAsSaleSql) — the Analytics "total sales"
 *   average order      revenue ÷ the orders in it
 *   cancellation rate  cancelled ÷ orders
 *   delivery rate      delivered ÷ orders that left with a courier
 *   return rate        returned or failed delivery ÷ orders that left with a
 *                      courier (as the Analytics delivery report)
 *
 * Products: the lines of the orders in the revenue. A variant counts for its
 * product (order_items.product_id). Units and revenue are what each line
 * stores — its quantity and its line total after the line's discount, before
 * the order's own discount. A combo is stored as one line per component
 * product, so each product counts its own part; a bundle or quantity offer is
 * one line of its product whose quantity is the number of offers bought.
 * Returned units are the units of lines in returned or failed-delivery orders.
 *
 * Money is in the store's currency, in minor units.
 */

const GOVERNORATE_SQL =
  "coalesce(nullif(o.shipping_address_snapshot->>'province', ''), nullif(o.shipping_address_snapshot->>'governorate', ''), nullif(o.shipping_address_snapshot->>'city', ''))";
const RETURNED = "('returned', 'delivery_failed')";
const EXPORT_LIMIT = 10000;
const LOW_STOCK_FALLBACK = 5;

const run = (sql, replacements) => db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** The orders in one window, with their stage and the facts the reports group by. Needs :workspaceId, :start, :end. */
const ORDERS_SQL = `
    SELECT o.id, o.order_number, o.created_at, o.payment_method, o.customer_id,
           o.total_amount AS total,
           (o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected' AND ${countsAsSaleSql('o')}) AS sale,
           ${STAGE_SQL} AS stage,
           ${GOVERNORATE_SQL} AS governorate,
           ls.carrier_code AS carrier
      FROM orders o${SHIPMENT_JOIN}
     WHERE o.workspace_id = :workspaceId AND o.created_at >= :start AND o.created_at < :end
       AND o.archived_at IS NULL AND NOT o.is_test`;

const ORDER_AGG = `
      count(*) AS orders,
      count(*) FILTER (WHERE sale) AS sale_orders,
      coalesce(sum(total) FILTER (WHERE sale), 0) AS revenue,
      count(*) FILTER (WHERE stage = 'cancelled') AS cancelled,
      count(*) FILTER (WHERE stage IN ${SHIPPED_STAGES}) AS shipped,
      count(*) FILTER (WHERE stage = 'delivered') AS delivered,
      count(*) FILTER (WHERE stage IN ${RETURNED}) AS returned`;

function orderFigures(r) {
  const orders = toNumber(r.orders);
  const saleOrders = toNumber(r.sale_orders);
  const revenue = toNumber(r.revenue);
  const shipped = toNumber(r.shipped);
  return {
    orders,
    revenue,
    averageOrderValue: saleOrders > 0 ? Math.round(revenue / saleOrders) : 0,
    cancellationRate: rate(toNumber(r.cancelled), orders),
    returnRate: rate(toNumber(r.returned), shipped),
    deliveryRate: rate(toNumber(r.delivered), shipped),
    cancelled: toNumber(r.cancelled),
    shipped,
    delivered: toNumber(r.delivered),
    returned: toNumber(r.returned),
  };
}

async function totals({ workspaceId, window }) {
  const [row] = await run(`WITH ord AS (${ORDERS_SQL}) SELECT ${ORDER_AGG} FROM ord`, { workspaceId, start: window.start, end: window.end });
  return orderFigures(row);
}

/** One row per bucket of the window (store time), empty ones included. */
async function series({ workspaceId, window, tz }, unit) {
  const rows = await run(
    `WITH buckets AS (
            SELECT generate_series(
                     date_trunc(:unit, CAST(:start AS timestamptz) AT TIME ZONE :tz),
                     date_trunc(:unit, (CAST(:end AS timestamptz) - interval '1 second') AT TIME ZONE :tz),
                     CAST(:step AS interval)) AS b),
          ord AS (${ORDERS_SQL}),
          o AS (
            SELECT date_trunc(:unit, created_at AT TIME ZONE :tz) AS b, count(*) AS orders,
                   coalesce(sum(total) FILTER (WHERE sale), 0) AS revenue
              FROM ord GROUP BY 1)
     SELECT to_char(buckets.b, 'YYYY-MM-DD"T"HH24:MI') AS bucket, coalesce(o.orders, 0) AS orders, coalesce(o.revenue, 0) AS revenue
       FROM buckets LEFT JOIN o ON o.b = buckets.b
      ORDER BY buckets.b`,
    { workspaceId, start: window.start, end: window.end, tz, unit, step: `1 ${unit}` }
  );
  return rows.map((r) => ({ bucket: r.bucket, orders: toNumber(r.orders), revenue: toNumber(r.revenue) }));
}

async function breakdowns({ workspaceId, window }) {
  const replacements = { workspaceId, start: window.start, end: window.end };
  const [stages, governorates, payments, carriers] = await Promise.all([
    run(`WITH ord AS (${ORDERS_SQL}) SELECT stage, ${ORDER_AGG} FROM ord GROUP BY 1`, replacements),
    run(`WITH ord AS (${ORDERS_SQL}) SELECT governorate AS name, ${ORDER_AGG} FROM ord GROUP BY 1 ORDER BY orders DESC, revenue DESC LIMIT 40`, replacements),
    run(`WITH ord AS (${ORDERS_SQL}) SELECT payment_method AS name, ${ORDER_AGG} FROM ord GROUP BY 1 ORDER BY orders DESC`, replacements),
    run(`WITH ord AS (${ORDERS_SQL}) SELECT carrier AS name, ${ORDER_AGG} FROM ord GROUP BY 1 ORDER BY orders DESC`, replacements),
  ]);
  const byStage = new Map(stages.map((r) => [r.stage, r]));
  const row = (r) => ({ name: r.name || null, ...orderFigures(r) });
  return {
    // Every stage of the Orders page, in its order, zero included.
    byStatus: STAGES.map((stage) => {
      const r = byStage.get(stage);
      return { status: stage, orders: r ? toNumber(r.orders) : 0, revenue: r ? toNumber(r.revenue) : 0 };
    }),
    byGovernorate: governorates.map(row),
    byPaymentMethod: payments.map(row),
    byCarrier: carriers.map(row),
  };
}

async function getOrdersReport(workspaceId, query = {}) {
  const ctx = await context(workspaceId, query);
  const compare = query.compare || 'previous';
  const unit = ['hour', 'day', 'week', 'month'].includes(query.unit) ? query.unit : autoUnit(ctx.window);
  const before = previousWindow(ctx.window, compare);
  const prev = before ? { ...ctx, window: before } : null;
  const [now, trend, parts, then, prevTrend] = await Promise.all([
    totals(ctx),
    series(ctx, unit),
    breakdowns(ctx),
    prev ? totals(prev) : null,
    prev ? series(prev, unit) : null,
  ]);
  const KPIS = ['orders', 'revenue', 'averageOrderValue', 'cancellationRate', 'returnRate', 'deliveryRate'];
  return {
    range: { from: ctx.window.start, to: ctx.window.end, timeZone: ctx.tz },
    previousRange: before ? { from: before.start, to: before.end } : null,
    compare,
    unit,
    currency: ctx.currency,
    kpis: Object.fromEntries(KPIS.map((k) => [k, { value: now[k], previous: then ? then[k] : null }])),
    counts: { cancelled: now.cancelled, shipped: now.shipped, delivered: now.delivered, returned: now.returned },
    series: trend,
    previousSeries: prevTrend,
    ...parts,
  };
}

// --- the orders behind the numbers -----------------------------------------------------

/** The table's filters (a breakdown row clicked) as conditions on the `ord` CTE. */
function tableFilter(query, replacements) {
  const conditions = [];
  if (query.status) {
    conditions.push('stage = :status');
    replacements.status = query.status;
  }
  if (query.governorate !== undefined) {
    if (query.governorate === '') conditions.push('governorate IS NULL');
    else {
      conditions.push('lower(governorate) = lower(:governorate)');
      replacements.governorate = query.governorate;
    }
  }
  if (query.paymentMethod) {
    conditions.push('payment_method = :paymentMethod');
    replacements.paymentMethod = query.paymentMethod;
  }
  if (query.carrier !== undefined) {
    if (query.carrier === '') conditions.push('carrier IS NULL');
    else {
      conditions.push('lower(carrier) = lower(:carrier)');
      replacements.carrier = query.carrier;
    }
  }
  return conditions;
}

function decodeCursor(cursor) {
  const [at, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ValidationError([{ field: 'cursor', message: 'Invalid cursor' }], 'Invalid query');
  }
  return { at: new Date(at), id };
}

/**
 * The orders of the range, newest first, keyset-paged. The customer's name
 * shows only to a teammate who may see orders (`withCustomers`) and only on
 * an order whose details aren't locked (orders/orderLock).
 */
async function listOrders(workspaceId, query = {}, { withCustomers = false, limit: hardLimit } = {}) {
  const ctx = await context(workspaceId, query);
  const limit = hardLimit || Math.min(Number(query.limit) || 50, 100);
  const replacements = { workspaceId, start: ctx.window.start, end: ctx.window.end, limit: limit + 1 };
  const conditions = tableFilter(query, replacements);
  if (query.cursor) {
    const { at, id } = decodeCursor(query.cursor);
    conditions.push('(ord.created_at, ord.id) < (:cursorAt, :cursorId)');
    Object.assign(replacements, { cursorAt: at, cursorId: id });
  }
  const lockCtx = withCustomers ? await orderLock.contextFor(workspaceId) : null;
  const visible = withCustomers ? orderLock.visibleSql(lockCtx, 'o2') : 'FALSE';
  const rows = await run(
    `WITH ord AS (${ORDERS_SQL})
     SELECT ord.id, ord.order_number, ord.created_at, ord.stage, ord.payment_method, ord.governorate, ord.carrier, ord.total, ord.sale,
            (SELECT coalesce(sum(i.quantity), 0) FROM order_items i WHERE i.order_id = ord.id) AS items,
            CASE WHEN ${withCustomers ? 'TRUE' : 'FALSE'} THEN (
              SELECT CASE WHEN ${visible} THEN nullif(o2.contact_snapshot->>'fullName', '') END FROM orders o2 WHERE o2.id = ord.id
            ) END AS customer_name,
            ${withCustomers ? `(SELECT NOT ${visible} FROM orders o2 WHERE o2.id = ord.id)` : 'FALSE'} AS contact_locked
       FROM ord
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY ord.created_at DESC, ord.id DESC
      LIMIT :limit`,
    replacements
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    currency: ctx.currency,
    timeZone: ctx.tz,
    orders: page.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      createdAt: r.created_at,
      status: r.stage,
      paymentMethod: r.payment_method,
      governorate: r.governorate || null,
      carrier: r.carrier || null,
      items: toNumber(r.items),
      total: toNumber(r.total),
      countsAsRevenue: Boolean(r.sale),
      customerName: withCustomers ? r.customer_name || null : undefined,
      contactLocked: withCustomers ? Boolean(r.contact_locked) : undefined,
    })),
    nextCursor: rows.length > limit && last ? Buffer.from(`${new Date(last.created_at).toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

const major = (minor) => (Number(minor) / 100).toFixed(2);
const percent = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(1));
const day = (d) => new Date(d).toISOString().slice(0, 10);

function toCsv(columns, rows) {
  const lines = [columns.map(([, title]) => csvCell(title)).join(',')];
  for (const row of rows) lines.push(columns.map(([key, , format]) => csvCell(format ? format(row[key], row) : row[key])).join(','));
  // The BOM makes Excel read Arabic names as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}

async function exportOrders(workspaceId, query = {}, opts = {}) {
  const ctx = await context(workspaceId, query);
  const list = await listOrders(workspaceId, { ...query, cursor: undefined }, { ...opts, limit: EXPORT_LIMIT });
  const local = (d) => {
    try {
      return new Intl.DateTimeFormat('sv-SE', { timeZone: ctx.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
    } catch {
      return new Date(d).toISOString();
    }
  };
  const columns = [
    ['orderNumber', 'Order'],
    ['createdAt', 'Placed', local],
    ['status', 'Status'],
    ...(opts.withCustomers ? [['customerName', 'Customer', (v, r) => (r.contactLocked ? '' : v || '')]] : []),
    ['paymentMethod', 'Payment method'],
    ['governorate', 'Governorate'],
    ['carrier', 'Courier'],
    ['items', 'Items'],
    ['total', 'Total', major],
    ['countsAsRevenue', 'Counts as revenue', (v) => (v ? 'yes' : 'no')],
  ];
  return {
    filename: `zimos-orders-${day(ctx.window.start)}-${day(ctx.window.end)}.csv`,
    body: toCsv(columns, list.orders),
    truncated: Boolean(list.nextCursor),
  };
}

// --- products --------------------------------------------------------------------------

/** Sold units, revenue, orders and returned units per product in the window. Needs the ORDERS_SQL replacements. */
const SOLD_SQL = `
    SELECT i.product_id,
           max(i.product_name_snapshot) AS snapshot_name,
           coalesce(sum(i.quantity), 0) AS units,
           coalesce(sum(i.line_total_amount), 0) AS revenue,
           count(DISTINCT ord.id) AS orders,
           coalesce(sum(i.quantity) FILTER (WHERE ord.stage IN ${RETURNED}), 0) AS returned_units
      FROM ord JOIN order_items i ON i.order_id = ord.id
     WHERE ord.sale AND i.product_id IS NOT NULL
     GROUP BY i.product_id`;

/** A product's stock, from its active variants: what can still be sold, and whether it is low or out. */
const STOCK_SQL = `
    SELECT v.product_id,
           sum(GREATEST(v.stock_on_hand - v.reserved_stock, 0))::int AS available,
           bool_and(NOT v.allow_overselling AND v.stock_on_hand - v.reserved_stock <= 0) AS out_of_stock,
           bool_or(NOT v.allow_overselling AND v.stock_on_hand - v.reserved_stock > 0
                   AND v.stock_on_hand - v.reserved_stock <= coalesce(v.low_stock_threshold, ${LOW_STOCK_FALLBACK})) AS low_stock,
           bool_or(v.allow_overselling) AS oversells
      FROM product_variants v
     WHERE v.workspace_id = :workspaceId AND v.status = 'active'
     GROUP BY v.product_id`;

const imageOf = (media) => {
  const list = Array.isArray(media) ? media : [];
  const first = list.find((m) => m && typeof m.url === 'string' && m.url);
  return first ? first.url : null;
};

function productRow(r, totalRevenue) {
  const revenue = toNumber(r.revenue);
  return {
    productId: r.product_id,
    name: r.name || r.snapshot_name || '',
    imageUrl: imageOf(r.media),
    status: r.status || null,
    units: toNumber(r.units),
    revenue,
    orders: toNumber(r.orders),
    returnedUnits: toNumber(r.returned_units),
    share: totalRevenue > 0 ? Math.round((revenue / totalRevenue) * 1000) / 10 : null,
    stock: r.available === null || r.available === undefined ? null : toNumber(r.available),
  };
}

async function getProductsReport(workspaceId, query = {}) {
  const ctx = await context(workspaceId, query);
  const limit = Math.min(Number(query.limit) || 10, 50);
  const replacements = { workspaceId, start: ctx.window.start, end: ctx.window.end, limit, unsoldLimit: query.unsoldLimit || 50 };
  const [rows, unsold, stock, [unsoldCount]] = await Promise.all([
    // Every product that sold in the range, with its stock.
    run(
      `WITH ord AS (${ORDERS_SQL}), sold AS (${SOLD_SQL}), stock AS (${STOCK_SQL})
       SELECT sold.*, p.name, p.media, p.status, stock.available
         FROM sold
         LEFT JOIN products p ON p.id = sold.product_id AND p.workspace_id = :workspaceId
         LEFT JOIN stock ON stock.product_id = sold.product_id
        ORDER BY sold.revenue DESC, sold.units DESC, sold.product_id`,
      replacements
    ),
    // Active products that sold nothing in the range, newest first.
    run(
      `WITH ord AS (${ORDERS_SQL}), sold AS (${SOLD_SQL}), stock AS (${STOCK_SQL})
       SELECT p.id AS product_id, p.name, p.media, p.status, 0 AS units, 0 AS revenue, 0 AS orders, 0 AS returned_units, stock.available
         FROM products p
         LEFT JOIN sold ON sold.product_id = p.id
         LEFT JOIN stock ON stock.product_id = p.id
        WHERE p.workspace_id = :workspaceId AND p.status = 'active' AND sold.product_id IS NULL
        ORDER BY p.created_at DESC, p.id
        LIMIT :unsoldLimit`,
      replacements
    ),
    // Low and out of stock: physical, active products whose variants keep a count.
    run(
      `WITH stock AS (${STOCK_SQL})
       SELECT p.id AS product_id, p.name, p.media, p.status, stock.available, stock.out_of_stock, stock.low_stock
         FROM products p JOIN stock ON stock.product_id = p.id
        WHERE p.workspace_id = :workspaceId AND p.status = 'active' AND p.product_type = 'physical'
          AND NOT stock.oversells AND (stock.out_of_stock OR stock.low_stock)
        ORDER BY stock.out_of_stock DESC, stock.available ASC, p.name
        LIMIT 100`,
      replacements
    ),
    run(
      `WITH ord AS (${ORDERS_SQL}), sold AS (${SOLD_SQL})
       SELECT count(*)::int AS n FROM products p LEFT JOIN sold ON sold.product_id = p.id
        WHERE p.workspace_id = :workspaceId AND p.status = 'active' AND sold.product_id IS NULL`,
      replacements
    ),
  ]);

  const totalRevenue = rows.reduce((sum, r) => sum + toNumber(r.revenue), 0);
  const totalUnits = rows.reduce((sum, r) => sum + toNumber(r.units), 0);
  const all = rows.map((r) => productRow(r, totalRevenue));
  const byUnits = [...all].sort((a, b) => b.units - a.units || b.revenue - a.revenue);
  const lowest = [...all].sort((a, b) => a.units - b.units || a.revenue - b.revenue);
  return {
    range: { from: ctx.window.start, to: ctx.window.end, timeZone: ctx.tz },
    currency: ctx.currency,
    totals: { revenue: totalRevenue, units: totalUnits, productsSold: all.length, productsUnsold: unsoldCount ? unsoldCount.n : 0 },
    topByRevenue: all.slice(0, limit),
    topByUnits: byUnits.slice(0, limit),
    lowestSellers: lowest.slice(0, limit),
    noSales: unsold.map((r) => productRow(r, totalRevenue)),
    stock: stock.map((r) => ({
      productId: r.product_id,
      name: r.name,
      imageUrl: imageOf(r.media),
      available: toNumber(r.available),
      state: r.out_of_stock ? 'out' : 'low',
    })),
    rows: all,
    lowStockFallback: LOW_STOCK_FALLBACK,
  };
}

/** One product's units and revenue per bucket of the range — the row's own trend. */
async function getProductTrend(workspaceId, productId, query = {}) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId }, attributes: ['id', 'name'] });
  if (!product) throw new NotFoundError('Product');
  const ctx = await context(workspaceId, query);
  const unit = autoUnit(ctx.window) === 'hour' ? 'hour' : autoUnit(ctx.window);
  const rows = await run(
    `WITH buckets AS (
            SELECT generate_series(
                     date_trunc(:unit, CAST(:start AS timestamptz) AT TIME ZONE :tz),
                     date_trunc(:unit, (CAST(:end AS timestamptz) - interval '1 second') AT TIME ZONE :tz),
                     CAST(:step AS interval)) AS b),
          ord AS (${ORDERS_SQL}),
          s AS (
            SELECT date_trunc(:unit, ord.created_at AT TIME ZONE :tz) AS b,
                   coalesce(sum(i.quantity), 0) AS units, coalesce(sum(i.line_total_amount), 0) AS revenue
              FROM ord JOIN order_items i ON i.order_id = ord.id
             WHERE ord.sale AND i.product_id = :productId
             GROUP BY 1)
     SELECT to_char(buckets.b, 'YYYY-MM-DD"T"HH24:MI') AS bucket, coalesce(s.units, 0) AS units, coalesce(s.revenue, 0) AS revenue
       FROM buckets LEFT JOIN s ON s.b = buckets.b ORDER BY buckets.b`,
    { workspaceId, productId, start: ctx.window.start, end: ctx.window.end, tz: ctx.tz, unit, step: `1 ${unit}` }
  );
  return {
    productId: product.id,
    name: product.name,
    unit,
    currency: ctx.currency,
    series: rows.map((r) => ({ bucket: r.bucket, units: toNumber(r.units), revenue: toNumber(r.revenue) })),
  };
}

async function exportProducts(workspaceId, query = {}) {
  const report = await getProductsReport(workspaceId, { ...query, limit: 10, unsoldLimit: EXPORT_LIMIT });
  const columns = [
    ['name', 'Product'],
    ['units', 'Units sold'],
    ['revenue', 'Revenue', major],
    ['share', 'Share of revenue %', percent],
    ['orders', 'Orders'],
    ['returnedUnits', 'Returned units'],
    ['stock', 'In stock', (v) => (v === null || v === undefined ? '' : v)],
  ];
  return {
    filename: `zimos-products-${day(report.range.from)}-${day(report.range.to)}.csv`,
    body: toCsv(columns, [...report.rows, ...report.noSales]),
  };
}

module.exports = { ORDERS_SQL, getOrdersReport, listOrders, exportOrders, getProductsReport, getProductTrend, exportProducts, LOW_STOCK_FALLBACK, EXPORT_LIMIT };
