'use strict';

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');

const money = (minor, currency) => `${(Number(minor) / 100).toFixed(2)} ${currency || ''}`.trim();

// Best-effort logo fetch; any failure returns null and the waybill uses text.
async function tryFetchLogo(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!/^image\/(png|jpe?g)/i.test(type)) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn(`[waybill] logo fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

async function barcodePng(text) {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: String(text),
    scale: 2,
    height: 12,
    includetext: false,
    backgroundcolor: 'FFFFFF',
  });
}

// Everything the waybill needs from an order, independent of rendering.
async function computeWaybillModel(workspaceId, orderId) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [{ model: db.Shipment, as: 'shipments' }],
  });
  if (!order) throw new NotFoundError('Order');

  const workspace = await db.Workspace.findByPk(workspaceId);
  // Newest shipment's tracking code, or the order number when there's no shipment.
  const shipment = (order.shipments || []).slice().sort((a, b) => b.createdAt - a.createdAt)[0];
  const trackingValue = (shipment && shipment.trackingCode) || order.orderNumber;
  const isCod = order.paymentMethod === 'cod';

  return {
    order,
    workspace,
    shipment,
    trackingValue,
    isCod,
    storeName: (workspace && workspace.name) || 'Store',
    amountToCollect: isCod ? String(order.totalAmount) : null,
    shipTo: order.contactSnapshot || {},
    address: order.shippingAddressSnapshot || {},
  };
}

// Renders the A5 waybill for an order and returns it as a PDF Buffer.
async function generateWaybillPdf(workspaceId, orderId) {
  const { order, workspace, trackingValue, isCod } = await computeWaybillModel(workspaceId, orderId);

  const [logo, barcode] = await Promise.all([tryFetchLogo(workspace && workspace.logoUrl), barcodePng(trackingValue)]);

  const contact = order.contactSnapshot || {};
  const addr = order.shippingAddressSnapshot || {};

  const doc = new PDFDocument({ size: 'A5', margin: 36 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // --- Header: logo (or store name) ---------------------------------------
  const storeName = (workspace && workspace.name) || 'Store';
  if (logo) {
    try {
      doc.image(logo, doc.page.margins.left, doc.y, { fit: [130, 46] });
      doc.moveDown(3);
    } catch (err) {
      doc.fontSize(18).font('Helvetica-Bold').text(storeName);
    }
  } else {
    doc.fontSize(18).font('Helvetica-Bold').text(storeName);
  }
  doc.fontSize(9).font('Helvetica').fillColor('#666').text(`Order ${order.orderNumber}`);
  doc.fillColor('#000');
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke('#ccc');
  doc.moveDown(0.8);

  // --- Tracking code: text + barcode ------------------------------------
  doc.fontSize(9).fillColor('#666').text('TRACKING CODE');
  doc.fontSize(16).font('Helvetica-Bold').fillColor('#000').text(trackingValue);
  doc.image(barcode, { fit: [260, 60] });
  doc.moveDown(1);

  // --- Ship to ---------------------------------------------------------
  doc.fontSize(9).font('Helvetica').fillColor('#666').text('SHIP TO');
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text(contact.fullName || '—');
  doc.fontSize(10).font('Helvetica').text(contact.phone || '');
  const addressLines = [
    addr.addressLine,
    [addr.city, addr.province].filter(Boolean).join(', '),
    [addr.country, addr.postalCode].filter(Boolean).join(' '),
  ].filter(Boolean);
  if (addressLines.length) doc.text(addressLines.join('\n'));
  else doc.fillColor('#999').text('No delivery address on file').fillColor('#000');
  doc.moveDown(1);

  // --- Payment -------------------------------------------------------
  if (isCod) {
    const boxTop = doc.y;
    doc.rect(doc.page.margins.left, boxTop, doc.page.width - doc.page.margins.left - doc.page.margins.right, 46)
      .fillAndStroke('#fff4e5', '#e08a00');
    doc.fillColor('#8a4b00').fontSize(10).font('Helvetica-Bold').text('COLLECT ON DELIVERY (CASH)', doc.page.margins.left + 10, boxTop + 8);
    doc.fontSize(18).text(money(order.totalAmount, order.currency), doc.page.margins.left + 10, boxTop + 20);
    doc.fillColor('#000');
    doc.y = boxTop + 56;
  } else {
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a7f37').text(`PREPAID — ${order.paymentMethod.toUpperCase()}`);
    doc.fillColor('#000');
  }
  doc.moveDown(0.8);

  doc.fontSize(8).font('Helvetica').fillColor('#666')
    .text(`Order date: ${new Date(order.createdAt).toISOString().slice(0, 10)}`);

  doc.end();
  return done;
}

module.exports = { generateWaybillPdf, computeWaybillModel };
