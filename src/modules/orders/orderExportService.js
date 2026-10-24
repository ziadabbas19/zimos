'use strict';

const db = require('../../db/models');
const { toDisplay } = require('../../core/utils/money');
const orderService = require('./orderService');

/**
 * Orders as a CSV file: the orders the list would show under the same search,
 * dates, stage and sort, with the columns the merchant picked, either one row
 * per order or one row per order line.
 *
 * It pages through orderService.listOrders rather than querying on its own,
 * so the file can never disagree with the screen about which orders match.
 * Rows are produced a page at a time and written as they come, so a large
 * export holds one page in memory, not the whole file.
 */

const PAGE_SIZE = 200;
// A ceiling, so one request cannot read the whole table: the file says so in
// its last line when it stops here, and a date range narrows it.
const MAX_ORDERS = 20000;

const money = (amount) => (amount === null || amount === undefined ? '' : toDisplay(String(amount)));
const contact = (o) => o.contactSnapshot || {};
const address = (o) => o.shippingAddressSnapshot || {};

// The words the dashboard shows for each code (pages/orders/orderLabels.ts),
// so a file reads like the screen it was exported from. [English, Arabic].
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

/** What one file is written with: its language and the store's own clock. */
function exportContext({ lang = 'en', timezone = 'UTC' } = {}) {
  // sv-SE writes a date as 2026-10-03 12:02:34, which every spreadsheet sorts.
  const clockFor = (timeZone) => new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'medium' });
  let clock;
  try {
    clock = clockFor(timezone);
  } catch {
    clock = clockFor('UTC');
  }
  return {
    lang,
    date: (value) => (value ? clock.format(new Date(value)) : ''),
    // An unknown code (a new stage, a courier's own word) is written as it is.
    label: (group, code) => {
      const words = LABELS[group] && LABELS[group][code];
      return words ? words[lang === 'ar' ? 1 : 0] : code || '';
    },
  };
}

function variantText(options) {
  if (!options || typeof options !== 'object') return '';
  return Object.entries(options)
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
}

/** "2 x Burger (Size: Large) [الحجم: كبير · إضافات: جبنة] = 260.00": quantity, product, variant, menu options, line total. */
function itemsDetailed(o) {
  const optionsLabel = require('../catalog/menuOptions').optionsLabel;
  return (o.items || [])
    .map((i) => {
      const variant = variantText(i.variantOptionsSnapshot);
      const options = optionsLabel(i.optionsSnapshot);
      return `${i.quantity} x ${i.productNameSnapshot}${variant ? ` (${variant})` : ''}${options ? ` [${options}]` : ''} = ${money(i.lineTotalAmount)}`;
    })
    .join(' | ');
}

/** Governorate, city, street and the address notes, in one cell. */
function fullAddress(o) {
  const a = address(o);
  return [a.region || a.province || a.governorate, a.city, a.addressLine, a.notes].filter(Boolean).join(' - ');
}

function itemsSummary(o) {
  return (o.items || [])
    .map((i) => {
      const variant = variantText(i.variantOptionsSnapshot);
      return `${i.quantity} x ${i.productNameSnapshot}${variant ? ` (${variant})` : ''}`;
    })
    .join(' | ');
}

/**
 * Every column a file can carry. `value(order, item, x)` — `item` is the order
 * line on a row-per-item export and null otherwise (the `item: true` columns
 * are the ones that only mean something per line), `x` the exportContext.
 */
const COLUMNS = [
  { key: 'orderNumber', en: 'Order number', ar: 'رقم الطلب', value: (o) => o.orderNumber },
  { key: 'createdAt', en: 'Date', ar: 'التاريخ', value: (o, i, x) => x.date(o.createdAt) },
  { key: 'stage', en: 'Stage', ar: 'المرحلة', value: (o, i, x) => x.label('stage', o.stage) },
  { key: 'confirmationState', en: 'Confirmation', ar: 'التأكيد', value: (o, i, x) => x.label('confirmation', o.confirmationState) },
  { key: 'financialState', en: 'Payment state', ar: 'حالة الدفع', value: (o, i, x) => x.label('financial', o.financialState) },
  { key: 'fulfillmentState', en: 'Fulfilment', ar: 'حالة الشحن', value: (o, i, x) => x.label('fulfillment', o.fulfillmentState) },
  { key: 'customerName', en: 'Customer', ar: 'العميل', value: (o) => contact(o).fullName },
  { key: 'phone', en: 'Phone', ar: 'الموبايل', value: (o) => contact(o).phone },
  { key: 'alternatePhone', en: 'Alternate phone', ar: 'موبايل بديل', value: (o) => contact(o).alternatePhone },
  { key: 'email', en: 'Email', ar: 'البريد الإلكتروني', value: (o) => contact(o).email },
  { key: 'country', en: 'Country', ar: 'الدولة', value: (o) => address(o).country },
  {
    key: 'region',
    en: 'Governorate',
    ar: 'المحافظة',
    value: (o) => address(o).region || address(o).province || address(o).governorate,
  },
  { key: 'city', en: 'City', ar: 'المدينة', value: (o) => address(o).city },
  { key: 'address', en: 'Address', ar: 'العنوان', value: (o) => address(o).addressLine },
  { key: 'addressNotes', en: 'Address notes', ar: 'ملاحظات العنوان', value: (o) => address(o).notes },
  { key: 'paymentMethod', en: 'Payment method', ar: 'طريقة الدفع', value: (o, i, x) => x.label('payment', o.paymentMethod) },
  { key: 'currency', en: 'Currency', ar: 'العملة', value: (o) => o.currency },
  { key: 'subtotal', en: 'Subtotal', ar: 'إجمالي المنتجات', value: (o) => money(o.subtotalAmount) },
  { key: 'discount', en: 'Discount', ar: 'الخصم', value: (o) => money(o.discountAmount) },
  { key: 'shipping', en: 'Shipping', ar: 'الشحن', value: (o) => money(o.shippingAmount) },
  { key: 'tax', en: 'Tax', ar: 'الضريبة', value: (o) => money(o.taxAmount) },
  { key: 'total', en: 'Total', ar: 'الإجمالي', value: (o) => money(o.totalAmount) },
  { key: 'amountPaid', en: 'Paid', ar: 'المدفوع', value: (o) => money(o.amountPaid) },
  { key: 'amountRefunded', en: 'Refunded', ar: 'المسترد', value: (o) => money(o.amountRefunded) },
  {
    key: 'discountCodes',
    en: 'Discount code',
    ar: 'كود الخصم',
    value: (o) =>
      (o.discountsSnapshot || [])
        .map((d) => d.code)
        .filter(Boolean)
        .join(', '),
  },
  { key: 'itemsCount', en: 'Items', ar: 'عدد القطع', value: (o) => (o.items || []).reduce((n, i) => n + i.quantity, 0) },
  { key: 'items', en: 'Products', ar: 'المنتجات', value: (o) => itemsSummary(o) },
  { key: 'itemsDetailed', en: 'Products, options and prices', ar: 'المنتجات والإضافات والأسعار', value: (o) => itemsDetailed(o) },
  { key: 'fullAddress', en: 'Full address', ar: 'العنوان كامل', value: (o) => fullAddress(o) },
  { key: 'source', en: 'Source', ar: 'المصدر', value: (o, i, x) => x.label('source', o.funnelId ? 'funnel' : 'store') },
  { key: 'carrier', en: 'Courier', ar: 'شركة الشحن', value: (o) => (o.shipment ? o.shipment.carrierCode : '') },
  { key: 'waybillNumber', en: 'Waybill', ar: 'رقم البوليصة', value: (o) => (o.shipment ? o.shipment.waybillNumber : '') },
  { key: 'trackingUrl', en: 'Tracking link', ar: 'رابط التتبع', value: (o) => (o.shipment ? o.shipment.trackingUrl : '') },
  {
    key: 'shipmentStatus',
    en: 'Shipment status',
    ar: 'حالة الشحنة',
    value: (o, i, x) => (o.shipment ? x.label('shipment', o.shipment.status) : ''),
  },
  { key: 'riskFlags', en: 'Risk flags', ar: 'علامات الخطر', value: (o) => (o.riskFlags || []).join(', ') },
  { key: 'notes', en: 'Notes', ar: 'ملاحظات', value: (o) => o.notes },
  { key: 'confirmedAt', en: 'Confirmed at', ar: 'وقت التأكيد', value: (o, i, x) => x.date(o.confirmedAt) },
  { key: 'cancelledAt', en: 'Cancelled at', ar: 'وقت الإلغاء', value: (o, i, x) => x.date(o.cancelledAt) },
  { key: 'cancellationReason', en: 'Cancellation reason', ar: 'سبب الإلغاء', value: (o) => o.cancellationReason },
  // Per order line.
  { key: 'productName', en: 'Product', ar: 'المنتج', item: true, value: (o, i) => (i ? i.productNameSnapshot : '') },
  { key: 'variant', en: 'Variant', ar: 'الخيار', item: true, value: (o, i) => (i ? variantText(i.variantOptionsSnapshot) : '') },
  { key: 'sku', en: 'SKU', ar: 'SKU', item: true, value: (o, i) => (i ? i.skuSnapshot : '') },
  { key: 'quantity', en: 'Quantity', ar: 'الكمية', item: true, value: (o, i) => (i ? i.quantity : '') },
  { key: 'unitPrice', en: 'Unit price', ar: 'سعر القطعة', item: true, value: (o, i) => (i ? money(i.unitPriceAmount) : '') },
  { key: 'lineTotal', en: 'Line total', ar: 'إجمالي السطر', item: true, value: (o, i) => (i ? money(i.lineTotalAmount) : '') },
];

const COLUMN_KEYS = COLUMNS.map((c) => c.key);
const byKey = new Map(COLUMNS.map((c) => [c.key, c]));

const DEFAULT_ORDER_COLUMNS = [
  'orderNumber',
  'createdAt',
  'stage',
  'customerName',
  'phone',
  'region',
  'city',
  'address',
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
];
const DEFAULT_ITEM_COLUMNS = [
  'orderNumber',
  'createdAt',
  'stage',
  'customerName',
  'phone',
  'region',
  'city',
  'productName',
  'variant',
  'sku',
  'quantity',
  'unitPrice',
  'lineTotal',
  'total',
  'currency',
];

/**
 * Ready-made exports with fixed columns, in a fixed order, so the file is the
 * same every time (a merchant's accountant imports it as it is).
 *
 *   accepted  the accepted orders (orders/orderAccepted.js: confirmed, or
 *             paid online; not cancelled), one row per order: number, date,
 *             customer, phone, address, the lines with quantities, options
 *             and prices, delivery, discount, total, currency, payment method
 *             and payment state. The list's date range and stage still apply.
 */
const PRESETS = Object.freeze({
  accepted: {
    columns: ['orderNumber', 'createdAt', 'customerName', 'phone', 'fullAddress', 'itemsDetailed', 'shipping', 'discount', 'total', 'currency', 'paymentMethod', 'financialState'],
    rowPer: 'order',
    filters: { accepted: true },
    fileName: 'orders-accepted',
  },
});
const PRESET_NAMES = Object.keys(PRESETS);

/**
 * The export's options with its preset applied: the preset's columns, rows
 * and filters win over anything sent. No preset: the options as they are.
 */
function applyPreset({ preset, columns, rowPer, ...filters }) {
  if (!preset) return { preset: null, columns, rowPer, filters, fileName: 'orders' };
  const p = PRESETS[preset];
  return { preset, columns: p.columns, rowPer: p.rowPer, filters: { ...filters, ...p.filters }, fileName: p.fileName };
}

/**
 * A preset's direct download is for a short range of orders: past either
 * limit the dashboard builds the file in the background instead
 * (exportFiles.js), where MAX_ORDERS still bounds it.
 */
const DIRECT_MAX_ORDERS = 2000;
const DIRECT_MAX_DAYS = 31;

/** null when the selection may download now, else why not (and how many orders it holds). */
async function directTooLarge(workspaceId, filters) {
  const { from, to } = filters;
  const days = from && to ? (new Date(to) - new Date(from)) / (24 * 60 * 60 * 1000) : Infinity;
  if (days > DIRECT_MAX_DAYS) return { reason: 'range', maxDays: DIRECT_MAX_DAYS, maxOrders: DIRECT_MAX_ORDERS };
  const count = await orderService.countOrders(workspaceId, filters);
  if (count > DIRECT_MAX_ORDERS) return { reason: 'rows', count, maxDays: DIRECT_MAX_DAYS, maxOrders: DIRECT_MAX_ORDERS };
  return null;
}

/** The catalogue the dashboard's export dialog is drawn from. */
function columnCatalogue() {
  return {
    columns: COLUMNS.map(({ key, en, ar, item }) => ({ key, label: { en, ar }, perItem: Boolean(item) })),
    defaults: { order: DEFAULT_ORDER_COLUMNS, item: DEFAULT_ITEM_COLUMNS },
    maxOrders: MAX_ORDERS,
    // The ready-made exports and the limits of their direct download.
    presets: Object.fromEntries(Object.entries(PRESETS).map(([name, p]) => [name, { columns: p.columns }])),
    direct: { maxOrders: DIRECT_MAX_ORDERS, maxDays: DIRECT_MAX_DAYS },
  };
}

// = + - @ (and their full-width forms) after any spaces or line breaks a
// spreadsheet may skip, or a tab / carriage return: the start of a formula.
const FORMULA_START = /^[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r]/;
// The same after a ";" — the list separator Excel splits a CSV on in many
// locales, so the text after it can become a cell of its own.
const FORMULA_AFTER_SEMICOLON = /;(?=[\s\u3000]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/g;

/**
 * One CSV cell. A value that a spreadsheet would run as a formula is
 * prefixed with an apostrophe (FORMULA_START), and so is every part of it
 * after a ";" that would start one: a customer can type anything into a
 * name or an address, and the file is opened in Excel by staff. A plain
 * number ("-5", "+201001234567") stays a number: it runs nothing. A cell
 * holding a quote, a comma, a ";", a tab or a line break is quoted.
 */
function cell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  text = text.replace(FORMULA_AFTER_SEMICOLON, ";'");
  return /[",;\t\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (values) => `${values.map(cell).join(',')}\r\n`;

/** The latest shipment of each order on the page that is not cancelled. */
async function shipmentsFor(workspaceId, orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = await db.Shipment.findAll({
    where: { workspaceId, orderId: orderIds },
    attributes: ['orderId', 'carrierCode', 'waybillNumber', 'trackingUrl', 'status', 'createdAt'],
    order: [['createdAt', 'ASC']],
  });
  const byOrder = new Map();
  for (const row of rows) {
    const current = byOrder.get(row.orderId);
    if (!current || row.status !== 'cancelled' || current.status === 'cancelled') byOrder.set(row.orderId, row);
  }
  return byOrder;
}

function resolveColumns(requested, rowPer) {
  const keys = requested && requested.length > 0 ? requested : rowPer === 'item' ? DEFAULT_ITEM_COLUMNS : DEFAULT_ORDER_COLUMNS;
  return keys.map((key) => byKey.get(key)).filter(Boolean);
}

/**
 * Yields the file a chunk at a time: the BOM and header first (the BOM is
 * what makes Excel read Arabic as UTF-8), then one chunk per page of orders.
 *
 * @param {string} workspaceId
 * @param {object} filters   the orders list query: q, from, to, stage, sort, the three states
 * @param {object} options   { columns: string[], rowPer: 'order' | 'item', lang: 'en' | 'ar', timezone, maskPhones }
 *
 * `maskPhones`: every phone written partly hidden (010****665), as the orders
 * list shows them to a teammate without customers.reveal_sensitive (SPEC §3.4 #8).
 */
/** The order as written to the file: phones masked when the teammate may not see them. */
function phoneShape(maskPhones) {
  return maskPhones ? require('../../core/utils/phoneMask').maskPhonesDeep : (row) => row;
}

async function* csvChunks(workspaceId, filters, { columns: requested, rowPer = 'order', lang = 'en', timezone, maskPhones = false } = {}) {
  const columns = resolveColumns(requested, rowPer);
  const shape = phoneShape(maskPhones);
  const x = exportContext({ lang, timezone });
  yield `﻿${line(columns.map((c) => (lang === 'ar' ? c.ar : c.en)))}`;

  const query = { ...filters, limit: PAGE_SIZE };
  delete query.cursor;
  let exported = 0;
  let cursor;
  do {
    const page = await orderService.listOrders(workspaceId, { ...query, cursor });
    const shipments = await shipmentsFor(
      workspaceId,
      page.orders.map((o) => o.id)
    );
    let chunk = '';
    for (const order of page.orders) {
      const row = shape({ ...order, shipment: shipments.get(order.id) || null });
      const items = rowPer === 'item' && row.items && row.items.length > 0 ? row.items : [null];
      for (const item of items) chunk += line(columns.map((c) => c.value(row, item, x)));
    }
    exported += page.orders.length;
    if (chunk) yield chunk;
    cursor = page.nextCursor;
  } while (cursor && exported < MAX_ORDERS);

  if (cursor) yield line([`Stopped at ${MAX_ORDERS} orders — narrow the date range to export the rest.`]);
}

// Columns that are amounts or counts: numeric cells in a spreadsheet, so they
// can be summed. Everything else stays text (a phone keeps its leading zero).
const NUMERIC_COLUMNS = new Set([
  'subtotal',
  'discount',
  'shipping',
  'tax',
  'total',
  'amountPaid',
  'amountRefunded',
  'itemsCount',
  'quantity',
  'unitPrice',
  'lineTotal',
]);

/**
 * The same table as csvChunks, as rows of cells (header first), for the xlsx
 * format. Built in memory: the spreadsheet is one zipped document, so there
 * is nothing to stream; MAX_ORDERS bounds it as it bounds the CSV.
 */
async function tableRows(workspaceId, filters, { columns: requested, rowPer = 'order', lang = 'en', timezone, maskPhones = false } = {}) {
  const columns = resolveColumns(requested, rowPer);
  const shape = phoneShape(maskPhones);
  const x = exportContext({ lang, timezone });
  const rows = [columns.map((c) => (lang === 'ar' ? c.ar : c.en))];
  const asCell = (column, value) => {
    if (value === null || value === undefined) return '';
    if (NUMERIC_COLUMNS.has(column.key) && /^-?\d+(\.\d+)?$/.test(String(value))) return Number(value);
    return String(value);
  };

  const query = { ...filters, limit: PAGE_SIZE };
  delete query.cursor;
  let exported = 0;
  let cursor;
  do {
    const page = await orderService.listOrders(workspaceId, { ...query, cursor });
    const shipments = await shipmentsFor(
      workspaceId,
      page.orders.map((o) => o.id)
    );
    for (const order of page.orders) {
      const row = shape({ ...order, shipment: shipments.get(order.id) || null });
      const items = rowPer === 'item' && row.items && row.items.length > 0 ? row.items : [null];
      for (const item of items) rows.push(columns.map((c) => asCell(c, c.value(row, item, x))));
    }
    exported += page.orders.length;
    cursor = page.nextCursor;
  } while (cursor && exported < MAX_ORDERS);
  if (cursor) rows.push([`Stopped at ${MAX_ORDERS} orders — narrow the date range to export the rest.`]);
  return rows;
}

module.exports = { csvChunks, tableRows, columnCatalogue, applyPreset, directTooLarge, cell, COLUMN_KEYS, PRESET_NAMES, MAX_ORDERS, DIRECT_MAX_ORDERS, DIRECT_MAX_DAYS };
