'use strict';

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const { registerFonts, drawText, hasArabic } = require('../../core/pdf/bidiText');
const { isCarrierBooked, FINISHED_STATUSES, codAmountFor } = require('../shipping/carrierShipmentService');
const { getAdapter, MANUAL } = require('../shipping/carriers');

const money = (minor, currency) => `${(Number(minor) / 100).toFixed(2)} ${currency || ''}`.trim();

// One line of QR text: user input may carry newlines.
const oneLine = (v) => String(v == null ? '' : v).replace(/\s*[\r\n]+\s*/g, ' ').trim();

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

// bwip-js encodes the text as UTF-8 bytes, so Arabic survives; phone
// scanners detect UTF-8 in byte mode without an ECI marker.
async function qrPng(text) {
  return bwipjs.toBuffer({
    bcid: 'qrcode',
    text,
    eclevel: 'M',
    scale: 4,
    backgroundcolor: 'FFFFFF',
  });
}

// The courier name and their own tracking number for a shipment. A manual
// row keeps the free-text name the merchant typed; `booked` is true only for
// one we booked through a connected courier (its label is the courier's).
function carrierInfo(shipment) {
  if (!shipment) return null;
  const adapter = getAdapter(shipment.carrierCode);
  let name = shipment.carrierCode;
  if (adapter) name = adapter.name;
  else if (shipment.carrierCode === MANUAL) name = 'Manual';
  return {
    name,
    trackingNumber: shipment.waybillNumber ? String(shipment.waybillNumber).trim() || null : null,
    booked: isCarrierBooked(shipment),
  };
}

function addressText(addr) {
  return [
    addr.addressLine,
    [addr.city, addr.province].filter(Boolean).join(', '),
    [addr.country, addr.postalCode].filter(Boolean).join(' '),
  ].filter(Boolean);
}

/**
 * The QR code's text: one "Key: value" line per field so any phone camera
 * shows it readably. Empty fields are left out, never printed as blanks.
 */
function buildQrPayload(model) {
  const { order, shipment, carrier, shipTo, address, isCod } = model;
  const lines = [
    ['Order', order.orderNumber],
    ['Tracking', shipment && shipment.trackingCode],
    ['Carrier', carrier && [carrier.name, carrier.trackingNumber].filter(Boolean).join(' ')],
    ['Name', shipTo.fullName],
    ['Phone', shipTo.phone],
    ['Address', addressText(address).join(', ')],
    ['COD', isCod ? money(order.totalAmount, order.currency) : `${money(0, order.currency)} (prepaid)`],
    ['Date', new Date(order.createdAt).toISOString().slice(0, 10)],
  ];
  return lines
    .map(([k, v]) => [k, oneLine(v)])
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// Everything the waybill needs from an order, independent of rendering.
async function computeWaybillModel(workspaceId, orderId) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [{ model: db.Shipment, as: 'shipments' }],
  });
  if (!order) throw new NotFoundError('Order');

  const workspace = await db.Workspace.findByPk(workspaceId);
  // The newest active shipment (not cancelled or returned). Its tracking code
  // goes in the barcode, or the order number when there's no shipment. A
  // shipment booked with a connected courier carries the courier's own
  // tracking number instead: that is what the courier scans.
  const shipment = (order.shipments || [])
    .filter((s) => !FINISHED_STATUSES.includes(s.status))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  const trackingValue = isCarrierBooked(shipment)
    ? shipment.waybillNumber : (shipment && shipment.trackingCode) || order.orderNumber;
  const isCod = order.paymentMethod === 'cod';

  const model = {
    order,
    workspace,
    shipment,
    carrier: carrierInfo(shipment),
    trackingValue,
    isCod,
    storeName: (workspace && workspace.name) || 'Store',
    // The same figure a courier booking sends as its COD amount: what is
    // still unpaid, not the order total.
    amountToCollect: isCod ? String(codAmountFor(order)) : null,
    shipTo: order.contactSnapshot || {},
    address: order.shippingAddressSnapshot || {},
  };
  model.qrPayload = buildQrPayload(model);
  return model;
}

const LABEL = '#666';

function label(doc, text, x, y) {
  doc.font('Helvetica').fontSize(8).fillColor(LABEL).text(text, x, y, { lineBreak: false });
  doc.fillColor('#000');
  return y + 11;
}

// Renders the A5 waybill for an order and returns it as a PDF Buffer.
async function generateWaybillPdf(workspaceId, orderId) {
  return renderWaybillPdf(await computeWaybillModel(workspaceId, orderId));
}

// Renders a computed model; no database access (scripts/waybill-samples.js
// feeds it hand-built models).
async function renderWaybillPdf(model) {
  const { order, workspace, shipment, carrier, trackingValue, isCod, storeName, shipTo, address } = model;

  const [logo, barcode, qr] = await Promise.all([
    tryFetchLogo(workspace && workspace.logoUrl),
    barcodePng(trackingValue),
    qrPng(model.qrPayload),
  ]);

  const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: `Waybill ${order.orderNumber}` } });
  registerFonts(doc);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // --- Header: logo (or store name) ---------------------------------------
  let logoDrawn = false;
  if (logo) {
    try {
      doc.image(logo, left, doc.y, { fit: [130, 46] });
      doc.y += 46 + 6;
      logoDrawn = true;
    } catch (err) {
      logoDrawn = false;
    }
  }
  if (!logoDrawn) drawText(doc, storeName, { size: 18, bold: true, align: 'left' });
  doc.font('Helvetica').fontSize(9).fillColor(LABEL).text(`Order ${order.orderNumber}`, left, doc.y);
  doc.fillColor('#000');
  doc.moveDown(0.5);
  doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke('#ccc');
  doc.y += 10;

  // --- Tracking code + barcode (left), QR code (right) -------------------
  // ~42mm square: modules stay around 0.6mm even for a long Arabic address.
  const QR = 118;
  const rowTop = doc.y;
  const colWidth = width - QR - 14;
  let y = label(doc, 'TRACKING CODE', left, rowTop);
  const ourCode = (shipment && shipment.trackingCode) || order.orderNumber;
  doc.font('Helvetica-Bold').fontSize(16).text(ourCode, left, y, { width: colWidth, lineBreak: false });
  y += 21;
  doc.image(barcode, left, y, { fit: [colWidth, 48], align: 'left' });
  y += 50;
  if (trackingValue !== ourCode) {
    // The barcode carries the courier's number; say so under it.
    doc.font('Helvetica').fontSize(8).fillColor(LABEL).text(trackingValue, left, y, { width: colWidth, lineBreak: false });
    doc.fillColor('#000');
    y += 11;
  }
  doc.image(qr, right - QR, rowTop, { fit: [QR, QR] });
  y = Math.max(y, rowTop + QR) + 10;

  // --- Carrier ---------------------------------------------------------
  if (carrier) {
    const half = width / 2;
    label(doc, 'CARRIER', left, y);
    if (carrier.trackingNumber) label(doc, 'CARRIER TRACKING NO.', left + half, y);
    y += 11;
    const nameBottom = drawText(doc, carrier.name, { x: left, y, width: half - 8, size: 12, bold: true, align: 'left' });
    let numberBottom = y;
    if (carrier.trackingNumber) {
      numberBottom = drawText(doc, carrier.trackingNumber, { x: left + half, y, width: half, size: 12, bold: true, align: 'left' });
    }
    y = Math.max(nameBottom, numberBottom);
    if (carrier.booked) {
      y = drawText(doc, `The courier scans ${carrier.name}'s own label. Print it from the shipment's Label button.`, {
        x: left, y: y + 1, width, size: 8, color: '#8a4b00', align: 'left',
      });
      doc.fillColor('#000');
    }
    y += 8;
  }

  doc.moveTo(left, y).lineTo(right, y).stroke('#eee');
  y += 8;

  // --- Ship to ---------------------------------------------------------
  // One alignment for the whole block — right when any of it is Arabic —
  // so English lines (country, phone) don't zig-zag against Arabic ones.
  y = label(doc, 'SHIP TO', left, y);
  const addressLines = addressText(address);
  const align = hasArabic([shipTo.fullName, ...addressLines].join(' ')) ? 'right' : 'left';
  y = drawText(doc, shipTo.fullName || '—', { x: left, y, width, size: 12, bold: true, align });
  if (shipTo.phone) y = drawText(doc, shipTo.phone, { x: left, y, width, size: 10, align, direction: 'ltr' });
  if (addressLines.length) {
    y = drawText(doc, addressLines.join('\n'), { x: left, y, width, size: 10, align });
  } else {
    y = drawText(doc, 'No delivery address on file', { x: left, y, width, size: 10, color: '#999' });
    doc.fillColor('#000');
  }
  y += 10;

  // --- Payment -------------------------------------------------------
  if (isCod) {
    doc.rect(left, y, width, 46).fillAndStroke('#fff4e5', '#e08a00');
    doc.fillColor('#8a4b00').fontSize(10).font('Helvetica-Bold').text('COLLECT ON DELIVERY (CASH)', left + 10, y + 8, { lineBreak: false });
    doc.fontSize(18).text(money(order.totalAmount, order.currency), left + 10, y + 20, { lineBreak: false });
    doc.fillColor('#000');
    y += 56;
  } else {
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a7f37')
      .text(`PREPAID — ${order.paymentMethod.toUpperCase()}`, left, y, { lineBreak: false });
    doc.fillColor('#000');
    y += 16;
  }
  y += 6;

  doc.fontSize(8).font('Helvetica').fillColor(LABEL)
    .text(`Order date: ${new Date(order.createdAt).toISOString().slice(0, 10)}`, left, y, { lineBreak: false });

  doc.end();
  return done;
}

module.exports = { generateWaybillPdf, renderWaybillPdf, computeWaybillModel, buildQrPayload, carrierInfo, qrPng };
