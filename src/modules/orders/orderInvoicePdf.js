'use strict';

const PDFDocument = require('pdfkit');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { registerFonts, drawText, hasArabic } = require('../../core/pdf/bidiText');

/**
 * GET /orders/:id/invoice.pdf — the order's invoice as a printable A4 page.
 *
 * The numbers are the invoice row's (invoices/invoiceService issues it when
 * the order becomes a sale and keeps it equal to the order when lines are
 * added or edited); the breakdown under the lines is the order's. An order
 * that is not a sale yet — an online order still waiting for its payment —
 * has no invoice, and says so (409 INVOICE_NOT_ISSUED).
 */
const money = (minor, currency) => `${(Number(minor) / 100).toFixed(2)} ${currency || ''}`.trim();

async function invoicePdf(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items' }] });
  if (!order) throw new NotFoundError('Order');
  const invoice = await db.Invoice.findOne({ where: { workspaceId, orderId: order.id }, order: [['issuedAt', 'DESC']] });
  if (!invoice) {
    throw new AppError('INVOICE_NOT_ISSUED', 'This order has no invoice yet: it is issued once the order is paid or placed as cash on delivery', 409);
  }
  const workspace = await db.Workspace.findByPk(workspaceId);

  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Invoice ${invoice.invoiceNumber}` } });
  registerFonts(doc);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve({ pdf: Buffer.concat(chunks), invoiceNumber: invoice.invoiceNumber })));
  // A locked order's invoice bills "••••" (orders/orderLock); its lines and totals print as they are.
  const [shown] = await shownForInvoice(workspaceId, [order]);
  drawInvoice(doc, { order: shown, invoice, workspace });
  doc.end();
  return done;
}

/** The orders as an invoice may show them: a locked one with its customer hidden (orders/orderLock). */
async function shownForInvoice(workspaceId, orders) {
  const orderLock = require('./orderLock');
  const ctx = await orderLock.contextFor(workspaceId);
  const locked = await orderLock.lockedIds(ctx, orders);
  return orders.map((o) => (locked.has(o.id) ? orderLock.maskOrder(o.toJSON(), ctx) : o));
}

/** One invoice, from the top of the current page (several share a document: orderInvoicesPdf.js). */
function drawInvoice(doc, { order, invoice, workspace }) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left * 2;
  const right = left + width;
  const currency = invoice.currency || order.currency;

  // ---- header
  let y = drawText(doc, (workspace && workspace.name) || 'Store', { x: left, y: 40, width: width / 2, size: 18, bold: true, align: 'left' });
  // The business on the invoice (account settings: workspaces/accountSettings.js).
  const legal = workspace ? require('../workspaces/accountSettings').accountOf(workspace).legal : null;
  if (legal) {
    const lines = [legal.company || legal.name, legal.address, [legal.phone, legal.country].filter(Boolean).join(' · ')].filter(Boolean);
    for (const line of lines) y = drawText(doc, line, { x: left, y, width: width / 2, size: 9, align: 'left' });
  }
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#222').text('INVOICE', left + width / 2, 40, { width: width / 2, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor('#555');
  doc.text(`No. ${invoice.invoiceNumber}`, left + width / 2, 66, { width: width / 2, align: 'right', lineBreak: false });
  doc.text(`Date: ${new Date(invoice.issuedAt).toISOString().slice(0, 10)}`, left + width / 2, 79, { width: width / 2, align: 'right', lineBreak: false });
  doc.text(`Order: ${order.orderNumber}`, left + width / 2, 92, { width: width / 2, align: 'right', lineBreak: false });
  doc.fillColor('#000');
  y = Math.max(y, 108) + 8;
  doc.moveTo(left, y).lineTo(right, y).stroke('#ccc');
  y += 12;

  // ---- bill to
  const contact = order.contactSnapshot || {};
  const address = order.shippingAddressSnapshot || {};
  const addressText = [address.addressLine, [address.city, address.province].filter(Boolean).join(', ')].filter(Boolean).join('\n');
  const align = hasArabic(`${contact.fullName || ''} ${addressText}`) ? 'right' : 'left';
  doc.font('Helvetica').fontSize(8).fillColor('#666').text('BILL TO', left, y, { lineBreak: false });
  doc.fillColor('#000');
  y += 12;
  y = drawText(doc, contact.fullName || '—', { x: left, y, width, size: 11, bold: true, align });
  if (contact.phone) y = drawText(doc, contact.phone, { x: left, y, width, size: 10, align, direction: 'ltr' });
  if (addressText) y = drawText(doc, addressText, { x: left, y, width, size: 10, align });
  y += 14;

  // ---- lines
  const cols = [
    { title: 'Item', w: width - 230, align: 'left' },
    { title: 'Qty', w: 50, align: 'right' },
    { title: 'Unit price', w: 90, align: 'right' },
    { title: 'Total', w: 90, align: 'right' },
  ];
  const tableHeader = () => {
    let x = left;
    doc.font('Helvetica-Bold').fontSize(9);
    for (const c of cols) {
      doc.text(c.title, x + 2, y, { width: c.w - 4, align: c.align, lineBreak: false });
      x += c.w;
    }
    y += 14;
    doc.moveTo(left, y).lineTo(right, y).stroke('#000');
    y += 5;
  };
  tableHeader();

  // The order's own lines carry the variant; the invoice row is the fallback.
  const lines = order.items.length
    ? order.items.map((i) => ({
        name: [i.productNameSnapshot, i.offerNameSnapshot, Object.values(i.variantOptionsSnapshot || {}).join(' / ')].filter(Boolean).join(' — '),
        quantity: i.quantity,
        unit: i.unitPriceAmount,
        total: i.lineTotalAmount,
      }))
    : (invoice.lineItems || []).map((l) => ({ name: l.name, quantity: l.quantity, unit: l.unitPriceAmount, total: l.lineTotalAmount }));

  for (const line of lines) {
    if (y > doc.page.height - 160) {
      doc.addPage();
      y = 40;
      tableHeader();
    }
    const bottom = drawText(doc, line.name || '—', { x: left + 2, y, width: cols[0].w - 6, size: 10, align: hasArabic(line.name || '') ? 'right' : 'left' });
    doc.font('Helvetica').fontSize(10);
    let x = left + cols[0].w;
    doc.text(String(line.quantity), x + 2, y, { width: cols[1].w - 4, align: 'right', lineBreak: false });
    x += cols[1].w;
    doc.text(money(line.unit, ''), x + 2, y, { width: cols[2].w - 4, align: 'right', lineBreak: false });
    x += cols[2].w;
    doc.text(money(line.total, ''), x + 2, y, { width: cols[3].w - 4, align: 'right', lineBreak: false });
    y = bottom + 4;
    doc.moveTo(left, y).lineTo(right, y).stroke('#e5e5e5');
    y += 5;
  }

  // ---- totals
  y += 6;
  const totalRow = (label, value, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10);
    doc.text(label, right - 240, y, { width: 130, align: 'right', lineBreak: false });
    doc.text(value, right - 110, y, { width: 108, align: 'right', lineBreak: false });
    y += bold ? 18 : 15;
  };
  totalRow('Subtotal', money(order.subtotalAmount, currency));
  if (Number(order.discountAmount) > 0) totalRow('Discount', `-${money(order.discountAmount, currency)}`);
  totalRow('Shipping', money(order.shippingAmount, currency));
  if (Number(order.taxAmount) > 0) totalRow('Tax', money(order.taxAmount, currency));
  doc.moveTo(right - 240, y).lineTo(right, y).stroke('#000');
  y += 5;
  totalRow('Total', money(invoice.totalAmount, currency), true);
  const paid = Number(order.amountPaid) - Number(order.amountRefunded);
  totalRow('Paid', money(Math.max(0, paid), currency));
  totalRow('Balance due', money(Math.max(0, Number(invoice.totalAmount) - Math.max(0, paid)), currency));

  y += 8;
  doc.font('Helvetica').fontSize(9).fillColor('#555');
  const method = { cod: 'Cash on delivery', card: 'Card', wallet: 'Wallet', bank_transfer: 'Bank transfer' }[order.paymentMethod] || order.paymentMethod;
  doc.text(`Payment method: ${method}`, left, y, { lineBreak: false });
  doc.fillColor('#000');
}

module.exports = { invoicePdf, drawInvoice, shownForInvoice };
