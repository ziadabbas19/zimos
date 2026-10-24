'use strict';

const Joi = require('joi');
const PDFDocument = require('pdfkit');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { registerFonts } = require('../../core/pdf/bidiText');
const { drawInvoice, shownForInvoice } = require('./orderInvoicePdf');

/**
 * POST /orders/documents/invoices { orderIds } — the selected orders'
 * invoices in one PDF, one page (or more) each, in the order given (SPEC
 * §4.3 "print selected"). An order with no invoice yet (an online order
 * still unpaid) is left out and named in `skipped`; when none has one,
 * 409 INVOICE_NOT_ISSUED.
 */

const MAX = 200;

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
  query: Joi.object({ as: Joi.string().valid('base64').optional() }),
  body: Joi.object({ orderIds: Joi.array().items(Joi.string().uuid()).min(1).max(MAX).unique().required() }),
};

async function invoicesPdf(workspaceId, orderIds) {
  const orders = await db.Order.findAll({ where: { workspaceId, id: orderIds }, include: [{ model: db.OrderItem, as: 'items' }] });
  const invoices = await db.Invoice.findAll({ where: { workspaceId, orderId: orderIds }, order: [['issuedAt', 'DESC']] });
  const latest = new Map();
  for (const invoice of invoices) if (!latest.has(invoice.orderId)) latest.set(invoice.orderId, invoice);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const printable = orderIds.map((id) => byId.get(id)).filter((o) => o && latest.has(o.id));
  const skipped = orderIds.map((id) => byId.get(id)).filter((o) => o && !latest.has(o.id)).map((o) => o.orderNumber);
  if (printable.length === 0) {
    throw new AppError('INVOICE_NOT_ISSUED', 'None of these orders has an invoice yet: it is issued once the order is paid or placed as cash on delivery', 409);
  }

  const workspace = await db.Workspace.findByPk(workspaceId);
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Invoices (${printable.length})` } });
  registerFonts(doc);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  // Locked orders bill "••••" (orders/orderLock).
  const shown = await shownForInvoice(workspaceId, printable);
  shown.forEach((order, i) => {
    if (i > 0) doc.addPage();
    drawInvoice(doc, { order, invoice: latest.get(order.id), workspace });
  });
  doc.end();
  return { pdf: await done, printed: printable.length, skipped };
}

// `?as=base64` answers JSON (the dashboard's request helper), with the orders left out.
const handler = asyncHandler(async (req, res) => {
  const { pdf, printed, skipped } = await invoicesPdf(req.tenant.workspaceId, req.body.orderIds);
  if (req.query.as === 'base64') {
    return res.json({ filename: 'invoices.pdf', contentType: 'application/pdf', base64: pdf.toString('base64'), printed, skipped });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="invoices.pdf"');
  return res.send(pdf);
});

module.exports = { schema, invoicesPdf, handler };
