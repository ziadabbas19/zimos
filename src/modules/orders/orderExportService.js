'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { toDisplay } = require('../../core/utils/money');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('./orderStage');
const { orderSort, orderByClause, afterAnchorClause } = require('./orderSort');
const { orderListConditions } = require('./orderService');
const { validTimeZone, MAX_RANGE_DAYS, DAY_MS } = require('../analytics/reportRange');

/**
 * Orders as a CSV file: the orders the list shows under the same search,
 * dates, stage, states and sort (orderService.orderListConditions), with the
 * columns the merchant picked, one row per order or one per order line.
 *
 * - Bounded: a file holds at most MAX_EXPORT_ROWS rows. The rows are counted
 *   before anything is written, and a larger export is refused with
 *   EXPORT_TOO_LARGE (and the count) so the merchant narrows the dates,
 *   rather than receiving a file that silently stops part way.
 * - Fixed: only orders placed up to the moment the export started are
 *   included, so the count and the rows describe the same set while new
 *   orders keep arriving.
 * - Streamed: pages of PAGE_SIZE orders are read by keyset and written as
 *   they come, so a large file holds one page in memory, never the whole set.
 * - Contact details: the phone, alternate phone and email columns need
 *   customers.reveal_sensitive, the same permission that reveals a customer's
 *   details on screen.
 * - Spreadsheet-safe: a cell that a spreadsheet would run as a formula is
 *   written as text (see `cell`).
 */

const PAGE_SIZE = 500;
const MAX_EXPORT_ROWS = 10000;

const SENSITIVE_COLUMNS = Object.freeze(['phone', 'alternatePhone', 'email']);

// The words the dashboard shows for each code (pages/orders/orderLabels.ts),
// so a file reads like the screen it came from. [English, Arabic]
const LABELS = {
  stage: {
    awaiting_payment: ['Awaiting payment', 'في انتظار الدفع'],
    pending_confirmation: ['New', 'جديد'],
    needs_follow_up: ['Follow up', 'للمتابعة'],
    ready_to_ship: ['Ready to ship', 'جاهز للشحن'],
    shipped: ['Shipped', 'تم الشحن'],
    out_for_delivery: ['Out for delivery', 'خرج للتوصيل'],
    delivery_failed: ['Delivery failed', 'فشل التوصيل'],
    delivered: ['Delivered', 'تم التسليم'],
    returned: ['Returned', 'مرتجع'],
    cancelled: ['Cancelled', 'ملغي'],
  },
  confirmation: {
    pending: ['Awaiting call', 'في انتظار المكالمة'],
    confirmed: ['Confirmed', 'مؤكد'],
    rejected: ['Rejected', 'مرفوض'],
    unreachable: ['Unreachable', 'لم يتم الوصول إليه'],
    postponed: ['Postponed', 'مؤجل'],
  },
  financial: {
    pending: ['Unpaid', 'غير مدفوع'],
    partially_paid: ['Partially paid', 'مدفوع جزئيًا'],
    paid: ['Paid', 'مدفوع'],
    failed: ['Payment failed', 'فشل الدفع'],
    refunded: ['Refunded', 'مسترد'],
    partially_refunded: ['Partially refunded', 'مسترد جزئيًا'],
  },
  fulfillment: {
    unfulfilled: ['Not shipped', 'لم يُشحن'],
    partially_fulfilled: ['Partially shipped', 'شُحن جزئيًا'],
    fulfilled: ['Fulfilled', 'مكتمل'],
    returned: ['Returned', 'مرتجع'],
  },
  shipment: {
    created: ['Created', 'تم الإنشاء'],
    picked_up: ['Picked up', 'تم الاستلام من المتجر'],
    in_transit: ['In transit', 'في الطريق'],
    out_for_delivery: ['Out for delivery', 'خرج للتوصيل'],
    delivered: ['Delivered', 'تم التسليم'],
    failed: ['Failed', 'فشل'],
    returned: ['Returned', 'مرتجع'],
    cancelled: ['Cancelled', 'ملغية'],
  },
  payment: {
    cod: ['Cash on delivery', 'الدفع عند الاستلام'],
    card: ['Card', 'بطاقة'],
    wallet: ['Wallet', 'محفظة إلكترونية'],
    bank_transfer: ['Bank transfer', 'تحويل بنكي'],
  },
  source: {
    store: ['Store', 'المتجر'],
    funnel: ['Funnel', 'مسار بيع'],
  },
};

const money = (amount) => (amount === null || amount === undefined ? '' : toDisplay(String(amount)));
const contact = (o) => o.contact_snapshot || {};
const address = (o) => o.shipping_address_snapshot || {};

function variantText(options) {
  if (!options || typeof options !== 'object') return '';
  return Object.entries(options)
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
}

function itemsSummary(o) {
  return (o.items || [])
    .map((i) => {
      const variant = variantText(i.variant_options_snapshot);
      return `${i.quantity} x ${i.product_name_snapshot}${variant ? ` (${variant})` : ''}`;
    })
    .join(' | ');
}

/**
 * Every column a file can carry. `value(order, item, x)`: `item` is the order
 * line on a row-per-line file and null otherwise (`perItem` columns only mean
 * something per line); `x` is the file's context (language, clock).
 * `needs` names the extra reads a column depends on, so a file without such a
 * column never makes them.
 */
const COLUMNS = [
  { key: 'orderNumber', en: 'Order number', ar: 'رقم الطلب', value: (o) => o.order_number },
  { key: 'createdAt', en: 'Date', ar: 'التاريخ', value: (o, i, x) => x.date(o.created_at) },
  { key: 'stage', en: 'Stage', ar: 'المرحلة', value: (o, i, x) => x.label('stage', o.stage) },
  { key: 'confirmationState', en: 'Confirmation', ar: 'التأكيد', value: (o, i, x) => x.label('confirmation', o.confirmation_state) },
  { key: 'financialState', en: 'Payment status', ar: 'حالة الدفع', value: (o, i, x) => x.label('financial', o.financial_state) },
  { key: 'fulfillmentState', en: 'Fulfillment', ar: 'حالة التنفيذ', value: (o, i, x) => x.label('fulfillment', o.fulfillment_state) },
  { key: 'customerName', en: 'Customer', ar: 'العميل', value: (o) => contact(o).fullName },
  { key: 'phone', en: 'Phone', ar: 'الهاتف', sensitive: true, value: (o) => contact(o).phone },
  { key: 'alternatePhone', en: 'Alternate phone', ar: 'هاتف بديل', sensitive: true, value: (o) => contact(o).alternatePhone },
  { key: 'email', en: 'Email', ar: 'البريد الإلكتروني', sensitive: true, value: (o) => contact(o).email },
  { key: 'country', en: 'Country', ar: 'الدولة', value: (o) => address(o).country },
  { key: 'province', en: 'Governorate', ar: 'المحافظة', value: (o) => address(o).province },
  { key: 'city', en: 'City', ar: 'المدينة', value: (o) => address(o).city },
  { key: 'addressLine', en: 'Address', ar: 'العنوان', value: (o) => address(o).addressLine },
  { key: 'postalCode', en: 'Postal code', ar: 'الرمز البريدي', value: (o) => address(o).postalCode },
  { key: 'addressNotes', en: 'Address notes', ar: 'ملاحظات العنوان', value: (o) => address(o).notes },
  { key: 'paymentMethod', en: 'Payment method', ar: 'طريقة الدفع', value: (o, i, x) => x.label('payment', o.payment_method) },
  { key: 'currency', en: 'Currency', ar: 'العملة', value: (o) => o.currency },
  { key: 'subtotal', en: 'Subtotal', ar: 'إجمالي المنتجات', value: (o) => money(o.subtotal_amount) },
  { key: 'discount', en: 'Discount', ar: 'الخصم', value: (o) => money(o.discount_amount) },
  { key: 'shipping', en: 'Shipping', ar: 'الشحن', value: (o) => money(o.shipping_amount) },
  { key: 'tax', en: 'Tax', ar: 'الضريبة', value: (o) => money(o.tax_amount) },
  { key: 'total', en: 'Total', ar: 'الإجمالي', value: (o) => money(o.total_amount) },
  { key: 'amountPaid', en: 'Paid', ar: 'المدفوع', value: (o) => money(o.amount_paid) },
  { key: 'amountRefunded', en: 'Refunded', ar: 'المسترد', value: (o) => money(o.amount_refunded) },
  {
    key: 'discountCodes',
    en: 'Discount codes',
    ar: 'أكواد الخصم',
    value: (o) =>
      (Array.isArray(o.discounts_snapshot) ? o.discounts_snapshot : [])
        .map((d) => d && d.code)
        .filter(Boolean)
        .join(', '),
  },
  { key: 'itemsCount', en: 'Items', ar: 'عدد القطع', needs: 'items', value: (o) => (o.items || []).reduce((n, i) => n + i.quantity, 0) },
  { key: 'items', en: 'Products', ar: 'المنتجات', needs: 'items', value: (o) => itemsSummary(o) },
  { key: 'source', en: 'Source', ar: 'المصدر', value: (o, i, x) => x.label('source', o.funnel_id ? 'funnel' : 'store') },
  { key: 'carrier', en: 'Courier', ar: 'شركة الشحن', needs: 'shipment', value: (o) => (o.shipment ? o.shipment.carrier_code : '') },
  { key: 'waybillNumber', en: 'Waybill', ar: 'رقم البوليصة', needs: 'shipment', value: (o) => (o.shipment ? o.shipment.waybill_number : '') },
  { key: 'trackingUrl', en: 'Tracking link', ar: 'رابط التتبع', needs: 'shipment', value: (o) => (o.shipment ? o.shipment.tracking_url : '') },
  {
    key: 'shipmentStatus',
    en: 'Shipment status',
    ar: 'حالة الشحنة',
    needs: 'shipment',
    value: (o, i, x) => (o.shipment ? x.label('shipment', o.shipment.status) : ''),
  },
  { key: 'notes', en: 'Notes', ar: 'ملاحظات', value: (o) => o.notes },
  { key: 'confirmedAt', en: 'Confirmed at', ar: 'وقت التأكيد', value: (o, i, x) => x.date(o.confirmed_at) },
  { key: 'cancelledAt', en: 'Cancelled at', ar: 'وقت الإلغاء', value: (o, i, x) => x.date(o.cancelled_at) },
  { key: 'cancellationReason', en: 'Cancellation reason', ar: 'سبب الإلغاء', value: (o) => o.cancellation_reason },
  // One order line each (rowPer=item).
  { key: 'productName', en: 'Product', ar: 'المنتج', perItem: true, needs: 'items', value: (o, i) => (i ? i.product_name_snapshot : '') },
  { key: 'variant', en: 'Variant', ar: 'النوع', perItem: true, needs: 'items', value: (o, i) => (i ? variantText(i.variant_options_snapshot) : '') },
  { key: 'sku', en: 'SKU', ar: 'رمز المنتج (SKU)', perItem: true, needs: 'items', value: (o, i) => (i ? i.sku_snapshot : '') },
  { key: 'quantity', en: 'Quantity', ar: 'الكمية', perItem: true, needs: 'items', value: (o, i) => (i ? i.quantity : '') },
  { key: 'unitPrice', en: 'Unit price', ar: 'سعر القطعة', perItem: true, needs: 'items', value: (o, i) => (i ? money(i.unit_price_amount) : '') },
  { key: 'lineTotal', en: 'Line total', ar: 'إجمالي السطر', perItem: true, needs: 'items', value: (o, i) => (i ? money(i.line_total_amount) : '') },
];

const COLUMN_KEYS = Object.freeze(COLUMNS.map((c) => c.key));
const byKey = new Map(COLUMNS.map((c) => [c.key, c]));

const DEFAULT_COLUMNS = Object.freeze({
  order: [
    'orderNumber',
    'createdAt',
    'stage',
    'customerName',
    'phone',
    'province',
    'city',
    'addressLine',
    'items',
    'itemsCount',
    'paymentMethod',
    'subtotal',
    'discount',
    'shipping',
    'total',
    'currency',
    'carrier',
    'waybillNumber',
    'notes',
  ],
  item: [
    'orderNumber',
    'createdAt',
    'stage',
    'customerName',
    'phone',
    'province',
    'city',
    'productName',
    'variant',
    'sku',
    'quantity',
    'unitPrice',
    'lineTotal',
    'total',
    'currency',
  ],
});

/** The catalogue the dashboard's export dialog is drawn from, for this caller. */
function columnCatalogue({ canRevealSensitive }) {
  const available = (key) => canRevealSensitive || !SENSITIVE_COLUMNS.includes(key);
  return {
    columns: COLUMNS.map(({ key, en, ar, perItem, sensitive }) => ({
      key,
      label: { en, ar },
      perItem: Boolean(perItem),
      sensitive: Boolean(sensitive),
      available: available(key),
    })),
    defaults: {
      order: DEFAULT_COLUMNS.order.filter(available),
      item: DEFAULT_COLUMNS.item.filter(available),
    },
    maxRows: MAX_EXPORT_ROWS,
    canRevealSensitive: Boolean(canRevealSensitive),
  };
}

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell. A value a spreadsheet would run as a formula — one starting
 * with = + - @, a tab or a carriage return — gets a leading apostrophe, which
 * makes Excel, LibreOffice and Google Sheets read it as text: a shopper can
 * type anything into a name or an address, and staff open the file in a
 * spreadsheet. Then the usual quoting: a value with a quote, comma or line
 * break is wrapped in quotes, with its quotes doubled.
 */
function cell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (values) => `${values.map(cell).join(',')}\r\n`;

/** What one file is written with: its language and the store's own clock. */
function fileContext({ lang, timeZone }) {
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return {
    // 2026-10-03 14:05:09 — sorts as text and every spreadsheet reads it.
    date: (value) => {
      if (!value) return '';
      const parts = Object.fromEntries(clock.formatToParts(new Date(value)).map((p) => [p.type, p.value]));
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    },
    // A code without a label (a courier's own status) is written as it is.
    label: (group, code) => {
      const words = LABELS[group] && LABELS[group][code];
      return words ? words[lang === 'ar' ? 1 : 0] : code || '';
    },
  };
}

/**
 * The columns of a file: the requested keys (already validated), or the
 * defaults for the row shape. Without customers.reveal_sensitive the defaults
 * leave the contact columns out, and asking for one by name is refused rather
 * than silently dropped: the merchant asked for it and should know why it is
 * missing.
 */
function resolveColumns(requested, rowPer, canRevealSensitive) {
  const isSensitive = (key) => SENSITIVE_COLUMNS.includes(key);
  let keys;
  if (requested && requested.length > 0) {
    const refused = canRevealSensitive ? [] : requested.filter(isSensitive);
    if (refused.length > 0) {
      throw new AppError(
        'FORBIDDEN',
        `Missing required permission: customers.reveal_sensitive (for ${refused.join(', ')})`,
        403,
        { columns: refused }
      );
    }
    keys = requested;
  } else {
    keys = DEFAULT_COLUMNS[rowPer].filter((key) => canRevealSensitive || !isSensitive(key));
  }
  return keys.map((key) => byKey.get(key)).filter(Boolean);
}

/**
 * Any date range of an export is at most MAX_RANGE_DAYS long, as for the
 * reports. `to` is inclusive of its whole UTC day, as on the orders list.
 * Without `from` the export is bounded by MAX_EXPORT_ROWS alone.
 */
function assertExportRange({ from, to }, now) {
  if (!from) return;
  const start = new Date(from);
  let end = now;
  if (to) {
    const day = new Date(to);
    end = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1));
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new ValidationError(
      [{ field: 'to', message: `The date range can be at most ${MAX_RANGE_DAYS} days` }],
      'Invalid query'
    );
  }
}

function run(sql, bind) {
  return db.sequelize.query(sql, { bind, type: QueryTypes.SELECT });
}

/** How many rows the file will have: orders, or order lines (at least one per order). */
async function countRows(workspaceId, filters, { rowPer, asOf }) {
  const { conditions, bind } = orderListConditions(workspaceId, filters);
  conditions.push('o.created_at <= $asOf::timestamptz');
  bind.asOf = asOf.toISOString();
  // The shipment join is only needed to filter by stage.
  const from = filters.stage ? ORDERS_WITH_STAGE_FROM : 'orders o';
  const [row] =
    rowPer === 'item'
      ? await run(
          `SELECT coalesce(sum(greatest(ic.lines, 1)), 0) AS rows
             FROM ${from}
             LEFT JOIN LATERAL (SELECT count(*) AS lines FROM order_items i WHERE i.order_id = o.id) ic ON TRUE
            WHERE ${conditions.join(' AND ')}`,
          bind
        )
      : await run(`SELECT count(*) AS rows FROM ${from} WHERE ${conditions.join(' AND ')}`, bind);
  return Number(row.rows);
}

/** The order lines of a page, by order id. The join keeps the read inside the workspace. */
async function itemsFor(workspaceId, orderIds) {
  const rows = await run(
    `SELECT i.order_id, i.product_name_snapshot, i.variant_options_snapshot, i.sku_snapshot,
            i.quantity, i.unit_price_amount, i.line_total_amount
       FROM order_items i
       JOIN orders o ON o.id = i.order_id AND o.workspace_id = $workspaceId
      WHERE i.order_id = ANY($orderIds::uuid[])
      ORDER BY i.order_id, i.created_at, i.id`,
    { workspaceId, orderIds }
  );
  const byOrder = new Map();
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
    byOrder.get(row.order_id).push(row);
  }
  return byOrder;
}

/** Each order's latest shipment that is not cancelled — the one its stage reads. */
async function shipmentsFor(workspaceId, orderIds) {
  const rows = await run(
    `SELECT DISTINCT ON (s.order_id) s.order_id, s.carrier_code, s.waybill_number, s.tracking_url, s.status
       FROM shipments s
      WHERE s.workspace_id = $workspaceId AND s.order_id = ANY($orderIds::uuid[]) AND s.status <> 'cancelled'
      ORDER BY s.order_id, s.created_at DESC, s.id DESC`,
    { workspaceId, orderIds }
  );
  return new Map(rows.map((r) => [r.order_id, r]));
}

/**
 * Validates the request and counts its rows; nothing is written yet, so every
 * refusal here still answers as a normal JSON error.
 *
 * @returns {{ columns, rowPer, lang, total, asOf, filters }}
 */
async function prepareExport(workspaceId, query, { canRevealSensitive, now = new Date() }) {
  const { columns: requested, rowPer = 'order', lang = 'en', sort, ...filters } = query;
  assertExportRange(filters, now);
  const columns = resolveColumns(requested, rowPer, canRevealSensitive);
  const total = await countRows(workspaceId, filters, { rowPer, asOf: now });
  if (total > MAX_EXPORT_ROWS) {
    throw new AppError(
      'EXPORT_TOO_LARGE',
      `This export has ${total} rows; a file holds at most ${MAX_EXPORT_ROWS}. Narrow the dates or filters.`,
      422,
      { rows: total, maxRows: MAX_EXPORT_ROWS }
    );
  }
  return { columns, rowPer, lang, sort, total, asOf: now, filters };
}

/**
 * Yields the file a chunk at a time: the byte-order mark and the header row
 * first (the BOM is what makes Excel read Arabic as UTF-8), then one chunk per
 * page of orders.
 */
async function* csvChunks(workspaceId, plan) {
  const { columns, rowPer, lang, filters, asOf } = plan;
  const workspace = await db.Workspace.findOne({ where: { id: workspaceId }, attributes: ['timezone'] });
  const x = fileContext({ lang, timeZone: validTimeZone(workspace && workspace.timezone) });
  const needsItems = rowPer === 'item' || columns.some((c) => c.needs === 'items');
  const needsShipment = columns.some((c) => c.needs === 'shipment');

  yield `﻿${line(columns.map((c) => (lang === 'ar' ? c.ar : c.en)))}`;

  const sort = orderSort(plan.sort);
  let anchor = null;
  for (;;) {
    const { conditions, bind } = orderListConditions(workspaceId, filters);
    conditions.push('o.created_at <= $asOf::timestamptz');
    bind.asOf = asOf.toISOString();
    bind.pageSize = PAGE_SIZE;
    if (anchor) {
      conditions.push(afterAnchorClause(sort, 'o.id', 'anchorValue', 'anchorId'));
      bind.anchorValue = anchor.value;
      bind.anchorId = anchor.id;
    }
    const page = await run(
      `SELECT o.id, o.order_number, o.created_at, o.confirmation_state, o.financial_state, o.fulfillment_state,
              o.payment_method, o.currency, o.subtotal_amount, o.discount_amount, o.shipping_amount, o.tax_amount,
              o.total_amount, o.amount_paid, o.amount_refunded, o.contact_snapshot, o.shipping_address_snapshot,
              o.discounts_snapshot, o.notes, o.funnel_id, o.confirmed_at, o.cancelled_at, o.cancellation_reason,
              o.created_at::text AS created_text, ${STAGE_SQL} AS stage
         FROM ${ORDERS_WITH_STAGE_FROM}
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderByClause(sort, 'o.id')}
        LIMIT $pageSize`,
      bind
    );
    if (page.length === 0) return;

    const ids = page.map((o) => o.id);
    const [items, shipments] = await Promise.all([
      needsItems ? itemsFor(workspaceId, ids) : Promise.resolve(new Map()),
      needsShipment ? shipmentsFor(workspaceId, ids) : Promise.resolve(new Map()),
    ]);

    let chunk = '';
    for (const order of page) {
      const row = { ...order, items: items.get(order.id) || [], shipment: shipments.get(order.id) || null };
      const lines = rowPer === 'item' && row.items.length > 0 ? row.items : [null];
      for (const item of lines) chunk += line(columns.map((c) => c.value(row, item, x)));
    }
    yield chunk;

    if (page.length < PAGE_SIZE) return;
    const last = page[page.length - 1];
    // The sort value as Postgres has it (microseconds included), not as a JS Date.
    anchor = { id: last.id, value: sort.anchor === 'totalAmount' ? String(last.total_amount) : last.created_text };
  }
}

module.exports = {
  prepareExport,
  csvChunks,
  columnCatalogue,
  cell,
  COLUMN_KEYS,
  SENSITIVE_COLUMNS,
  MAX_EXPORT_ROWS,
  PAGE_SIZE,
};
