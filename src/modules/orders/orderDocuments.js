'use strict';

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { registerFonts, drawText, hasArabic } = require('../../core/pdf/bidiText');
const { computeWaybillModel } = require('../waybill/waybillService');
const { codAmountFor } = require('../shipping/carrierShipmentService');
const { dayWindow } = require('../../core/utils/zonedMonth');

/**
 * Printed paper for many orders at once (SPEC §12.4):
 *
 *   waybills   one PDF of labels — four to an A4 page, or one per 10×15 cm
 *              thermal label — for the orders picked in the list;
 *   manifest   the handover sheet the courier signs: every parcel handed
 *              over, its waybill number and the cash to collect.
 *
 * The label is a compact form of the single-order waybill and reads the same
 * model (waybill/waybillService.computeWaybillModel), so the barcode and the
 * amount to collect are the ones the single waybill prints.
 */

const MAX_DOCUMENT_ORDERS = 200;
// The day "today's manifest" covers is a day in Egypt, not a UTC day.
const MANIFEST_TIME_ZONE = 'Africa/Cairo';
const money = (minor, currency) => `${(Number(minor) / 100).toFixed(2)} ${currency || ''}`.trim();
const mm = (n) => (n * 72) / 25.4;

const FORMATS = {
  // A4 portrait, 2 × 2.
  a4x4: { size: 'A4', perPage: 4, cell: (doc, i) => {
    const margin = 18;
    const w = (doc.page.width - margin * 3) / 2;
    const h = (doc.page.height - margin * 3) / 2;
    return { x: margin + (i % 2) * (w + margin), y: margin + Math.floor(i / 2) * (h + margin), w, h };
  } },
  // 10 × 15 cm thermal label, one per page.
  '10x15': { size: [mm(100), mm(150)], perPage: 1, cell: (doc) => ({ x: 10, y: 10, w: doc.page.width - 20, h: doc.page.height - 20 }) },
};

function collect(doc) {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  return new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
}

async function barcodePng(text) {
  return bwipjs.toBuffer({ bcid: 'code128', text: String(text), scale: 2, height: 11, includetext: false, backgroundcolor: 'FFFFFF' });
}

function addressLines(address) {
  if (!address) return [];
  return [address.addressLine, [address.city, address.province].filter(Boolean).join(', '), address.notes].filter(Boolean);
}

/** One label inside the box { x, y, w, h }. */
async function drawLabel(doc, model, box) {
  const { order, shipment, carrier, trackingValue, isCod, storeName, shipTo, address } = model;
  const pad = 10;
  const x = box.x + pad;
  const w = box.w - pad * 2;
  let y = box.y + pad;

  doc.lineWidth(0.8).rect(box.x, box.y, box.w, box.h).stroke('#999');

  y = drawText(doc, storeName, { x, y, width: w, size: 12, bold: true, align: 'left' });
  doc.font('Helvetica').fontSize(8).fillColor('#666').text(`Order ${order.orderNumber}`, x, y, { lineBreak: false });
  doc.fillColor('#000');
  y += 12;

  doc.image(await barcodePng(trackingValue), x, y, { fit: [w, 40] });
  y += 42;
  doc.font('Helvetica-Bold').fontSize(10).text(String(trackingValue), x, y, { width: w, lineBreak: false });
  y += 14;
  if (carrier && carrier.name) {
    y = drawText(doc, carrier.name, { x, y, width: w, size: 9, align: 'left' });
  }
  y += 4;
  doc.moveTo(x, y).lineTo(x + w, y).stroke('#ccc');
  y += 6;

  const lines = addressLines(address);
  const align = hasArabic([shipTo.fullName, ...lines].join(' ')) ? 'right' : 'left';
  y = drawText(doc, shipTo.fullName || '—', { x, y, width: w, size: 12, bold: true, align });
  if (shipTo.phone) y = drawText(doc, shipTo.phone, { x, y, width: w, size: 11, align, direction: 'ltr' });
  if (lines.length) y = drawText(doc, lines.join('\n'), { x, y, width: w, size: 10, align });

  // The amount sits at the foot of the label whatever the address length.
  const footY = box.y + box.h - pad - 34;
  // The custom-field answers, as many as fit above it (waybill/customData.js).
  if (model.customData && model.customData.length) {
    require('../waybill/customData').drawCustomData(doc, model.customData, { x, y: y + 4, width: w, size: 8, maxY: footY - 4 });
  }
  if (isCod) {
    doc.rect(x, footY, w, 34).fillAndStroke('#fff4e5', '#e08a00');
    doc.fillColor('#8a4b00').font('Helvetica-Bold').fontSize(8).text('COLLECT (CASH)', x + 6, footY + 5, { lineBreak: false });
    doc.fontSize(14).text(money(model.amountToCollect, order.currency), x + 6, footY + 16, { lineBreak: false });
  } else {
    doc.rect(x, footY, w, 34).stroke('#1a7f37');
    doc.fillColor('#1a7f37').font('Helvetica-Bold').fontSize(11).text('PREPAID — DO NOT COLLECT', x + 6, footY + 12, { lineBreak: false });
  }
  doc.fillColor('#000');
  return shipment;
}

async function assertOrders(workspaceId, orderIds) {
  const ids = [...new Set(orderIds)];
  if (ids.length > MAX_DOCUMENT_ORDERS) {
    throw new AppError('TOO_MANY_ORDERS', `At most ${MAX_DOCUMENT_ORDERS} orders can be printed at once`, 422);
  }
  const found = await db.Order.findAll({ where: { workspaceId, id: ids }, attributes: ['id'] });
  const known = new Set(found.map((o) => o.id));
  const kept = ids.filter((id) => known.has(id));
  if (kept.length === 0) throw new AppError('NO_ORDERS_SELECTED', 'No orders match this selection', 422);
  return kept;
}

/** The labels of the given orders, in the order given, as one PDF. */
async function waybillsPdf(workspaceId, { orderIds, format = 'a4x4' }) {
  const layout = FORMATS[format] || FORMATS.a4x4;
  const ids = await assertOrders(workspaceId, orderIds);

  const doc = new PDFDocument({ size: layout.size, margin: 0, autoFirstPage: false, info: { Title: 'Waybills' } });
  registerFonts(doc);
  const done = collect(doc);
  for (const [index, id] of ids.entries()) {
    const slot = index % layout.perPage;
    if (slot === 0) doc.addPage({ size: layout.size, margin: 0 });
    await drawLabel(doc, await computeWaybillModel(workspaceId, id), layout.cell(doc, slot));
  }
  doc.end();
  return done;
}

/**
 * The rows of the courier handover sheet. The parcels are the given orders'
 * live shipments, or — with no orders named — every shipment created on the
 * Africa/Cairo day `date` falls in (default today), optionally for one
 * courier. Returns { day, rows } where day is YYYY-MM-DD (null for a named
 * selection) and each row carries what the courier needs at the door.
 */
async function manifestRows(workspaceId, { orderIds, date, carrier, courierId } = {}) {
  const where = { workspaceId, status: { [Op.notIn]: ['cancelled', 'returned'] } };
  let day = null;
  if (orderIds && orderIds.length) {
    where.orderId = await assertOrders(workspaceId, orderIds);
  } else {
    const window = dayWindow(date ? new Date(date) : new Date(), MANIFEST_TIME_ZONE);
    day = window.day;
    where.createdAt = { [Op.gte]: window.start, [Op.lt]: window.end };
  }
  if (carrier) where.carrierCode = { [Op.iLike]: carrier };
  if (courierId) where.courierId = courierId;

  const shipments = await db.Shipment.findAll({
    where,
    include: [
      { model: db.Order, as: 'order', include: [{ model: db.OrderItem, as: 'items', attributes: ['productNameSnapshot', 'quantity', 'optionsSnapshot'] }] },
      { model: db.Courier, as: 'courier', attributes: ['id', 'name', 'phone'] },
    ],
    order: [['carrierCode', 'ASC'], ['createdAt', 'ASC']],
    limit: 1000,
  });
  // One row per order: its newest live shipment.
  const byOrder = new Map();
  for (const s of shipments) byOrder.set(s.orderId, s);
  // A locked order (orders/orderLock) is listed with its customer hidden; the governorate stays.
  const orderLock = require('./orderLock');
  const lockCtx = await orderLock.contextFor(workspaceId);
  const locked = await orderLock.lockedIds(lockCtx, [...byOrder.values()].map((s) => s.order));
  const rows = [...byOrder.values()].map((s) => {
    const o = s.order;
    const hidden = locked.has(o.id);
    const contact = hidden ? orderLock.maskContact(o.contactSnapshot || {}) : o.contactSnapshot || {};
    const address = hidden ? orderLock.maskAddress(o.shippingAddressSnapshot || {}) : o.shippingAddressSnapshot || {};
    return {
      orderId: o.id,
      orderNumber: o.orderNumber,
      waybill: s.waybillNumber || s.trackingCode || '',
      customerName: contact.fullName || '',
      phone: contact.phone || '',
      alternatePhone: contact.alternatePhone || '',
      governorate: address.province || '',
      city: address.city || '',
      addressLine: address.addressLine || '',
      addressNotes: address.notes || '',
      // The delivery zone the customer picked (shipping/deliveryZones.js), when the store uses zones.
      zone: (o.shippingSnapshot && o.shippingSnapshot.zone && o.shippingSnapshot.zone.name) || '',
      // The store's courier by name (a renamed courier shows the new name), else the text typed.
      courier: (s.courier && s.courier.name) || s.carrierCode || '',
      courierId: s.courierId || null,
      // Collected from the store: on the sheet, but not for a courier.
      pickup: o.deliveryMethod === 'pickup',
      // What is in the bag, menu options included (catalog/menuOptions.js): "2× برجر (الحجم: كبير)".
      items: (o.items || [])
        .map((i) => {
          const options = require('../catalog/menuOptions').optionsLabel(i.optionsSnapshot);
          return `${i.quantity}× ${i.productNameSnapshot}${options ? ` (${options})` : ''}`;
        })
        .join(' | '),
      paymentMethod: o.paymentMethod,
      collectAmount: o.paymentMethod === 'cod' ? codAmountFor(o) : 0,
      currency: o.currency,
    };
  });
  // Grouped by courier (id, else the name typed), in the order the parcels were handed over.
  const key = (r) => r.courierId || `name:${r.courier.toLowerCase()}`;
  const firstSeen = new Map();
  rows.forEach((r, i) => { if (!firstSeen.has(key(r))) firstSeen.set(key(r), i); });
  rows.sort((a, b) => firstSeen.get(key(a)) - firstSeen.get(key(b)));
  return { day, rows };
}

/** The courier handover sheet as a PDF (see manifestRows). */
async function manifestPdf(workspaceId, selection = {}) {
  const { day, rows } = await manifestRows(workspaceId, selection);
  if (rows.length === 0) throw new AppError('NO_SHIPMENTS', 'There are no shipments to hand over for this selection', 422);

  const workspace = await db.Workspace.findByPk(workspaceId);
  const doc = new PDFDocument({ size: 'A4', margin: 32, info: { Title: 'Courier manifest' } });
  registerFonts(doc);
  const done = collect(doc);
  const left = doc.page.margins.left;
  const width = doc.page.width - left * 2;
  const currency = rows[0].currency;
  const printedDay = day || dayWindow(new Date(), MANIFEST_TIME_ZONE).day;

  const cols = [
    { title: '#', w: 18 },
    { title: 'Order', w: 82 },
    { title: 'Customer', w: 80 },
    { title: 'Phone', w: 70 },
    { title: 'Address', w: 160 },
    { title: 'Courier', w: 60 },
    { title: 'Collect', w: width - 470 },
  ];

  const header = () => {
    let y = drawText(doc, (workspace && workspace.name) || 'Store', { x: left, y: doc.page.margins.top, width, size: 15, bold: true, align: 'left' });
    const couriers = [...new Set(rows.map((r) => r.courier))].join(', ');
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    y = drawText(doc, `Courier handover manifest — ${printedDay} — ${couriers}`, {
      x: left, y: y + 2, width, size: 9, align: 'left',
    });
    doc.fillColor('#000');
    y += 8;
    let x = left;
    doc.font('Helvetica-Bold').fontSize(8);
    for (const c of cols) {
      doc.text(c.title, x + 2, y, { width: c.w - 4, lineBreak: false });
      x += c.w;
    }
    y += 12;
    doc.moveTo(left, y).lineTo(left + width, y).stroke('#000');
    return y + 4;
  };

  let y = header();
  let total = 0;
  for (const [index, r] of rows.entries()) {
    if (y > doc.page.height - 130) {
      doc.addPage();
      y = header();
    }
    total += r.collectAmount;
    const place = r.pickup ? 'PICKUP — collected at the store' : [r.zone, r.governorate, r.city].filter(Boolean).join(' - ');
    const cells = [
      String(index + 1),
      [r.orderNumber, r.waybill].filter(Boolean).join('\n'),
      r.customerName || '—',
      [r.phone, r.alternatePhone].filter(Boolean).join('\n'),
      [place, r.addressLine, r.addressNotes, r.items].filter(Boolean).join('\n'),
      r.pickup ? 'PICKUP' : r.courier,
      r.paymentMethod === 'cod' ? money(r.collectAmount, '') : 'prepaid',
    ];
    let x = left;
    let bottom = y;
    for (const [i, c] of cols.entries()) {
      const b = drawText(doc, String(cells[i]), { x: x + 2, y, width: c.w - 4, size: 8, align: 'left', direction: i === 3 ? 'ltr' : undefined });
      bottom = Math.max(bottom, b);
      x += c.w;
    }
    y = bottom + 3;
    doc.moveTo(left, y).lineTo(left + width, y).stroke('#ddd');
    y += 3;
  }

  y += 8;
  doc.font('Helvetica-Bold').fontSize(11).text(`Parcels: ${rows.length}`, left, y, { lineBreak: false });
  doc.text(`Cash to collect: ${money(total, currency)}`, left + 180, y, { lineBreak: false });
  y += 40;
  doc.font('Helvetica').fontSize(9);
  doc.text('Handed over by: ______________________', left, y, { lineBreak: false });
  doc.text('Received by (courier): ______________________', left + width / 2, y, { lineBreak: false });

  doc.end();
  return done;
}

module.exports = { MAX_DOCUMENT_ORDERS, FORMATS: Object.keys(FORMATS), MANIFEST_TIME_ZONE, waybillsPdf, manifestRows, manifestPdf };
