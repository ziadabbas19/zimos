'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./orderService');
const confirmationService = require('../cod/confirmationService');
const stageChange = require('./orderStageChange');
const statusHistory = require('./orderStatusHistory');
const orderMeta = require('./orderMetaService');
const orderTimeline = require('./orderTimeline');
const orderBulk = require('./orderBulkService');
const manualOrder = require('./manualOrder');
const itemsEdit = require('./orderItemsEdit');
const orderFulfill = require('./orderFulfill');
const orderDocuments = require('./orderDocuments');
const trackingImport = require('./trackingImport');
const { invoicePdf: buildInvoicePdf } = require('./orderInvoicePdf');
const orderLock = require('./orderLock');

// Every order a handler answers with goes out through the lock (orderLock):
// a locked order's customer details hidden, `contactLocked` on every order.
const present = (req, order) => {
  if (!order) return order;
  const plain = typeof order.toJSON === 'function' ? order.toJSON() : order;
  return 'contactLocked' in plain ? plain : orderLock.presentOrder(req.tenant.workspaceId, plain);
};

const create = asyncHandler(async (req, res) => {
  const { shippingAmount, ...body } = req.body;
  const { order, items } = await service.createOrder(req.tenant.workspaceId, body, req, {
    shippingOverride: manualOrder.shippingOverrideOf({ shippingAmount }),
  });
  res.status(201).json({ order: await present(req, { ...order.toJSON(), items }) });
});

const manualPreview = asyncHandler(async (req, res) => {
  res.json({ preview: await manualOrder.preview(req.tenant.workspaceId, req.body, req) });
});

const manualCustomer = asyncHandler(async (req, res) => {
  res.json({ customer: await manualOrder.customerByPhone(req.tenant.workspaceId, req.query.phone) });
});

const manualOptions = asyncHandler(async (req, res) => {
  res.json(manualOrder.options());
});

const get = asyncHandler(async (req, res) => {
  const order = await service.getOrder(req.tenant.workspaceId, req.params.orderId);
  res.json({ order });
});

const list = asyncHandler(async (req, res) => {
  const result = await service.listOrders(req.tenant.workspaceId, req.query);
  // Phones in the list are masked for roles without customers.reveal_sensitive.
  res.json(require('../../core/utils/phoneMask').forViewer(req, result));
});

const pipeline = asyncHandler(async (req, res) => {
  res.json(await service.orderPipeline(req.tenant.workspaceId, req.query));
});

// GET /orders/locked-summary — { enabled, mode, reason, canPay, count, due, totals, fee?, balance?, freeLeft? }
const lockedSummary = asyncHandler(async (req, res) => {
  res.json({ locked: await orderLock.lockedSummary(req.tenant.workspaceId) });
});

// POST /orders/locked/settle — the fees of orders paid online while the
// balance could not pay them, taken now while it can; then the summary.
const settleLocked = asyncHandler(async (req, res) => {
  const result = await require('../billing/confirmFeeService').settleDue(req.tenant.workspaceId);
  res.json({ ...result, locked: await orderLock.lockedSummary(req.tenant.workspaceId) });
});

const cancel = asyncHandler(async (req, res) => {
  const order = await service.cancelOrder(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.json({ order: await present(req, order) });
});

// Confirm from the order page: the same outcome a queue call records.
const confirm = asyncHandler(async (req, res) => {
  const task = await confirmationService.confirmFromOrder(req.tenant.workspaceId, req.params.orderId, req.body, req);
  const order = await service.getOrder(req.tenant.workspaceId, req.params.orderId);
  res.json({ order, task });
});

const changeStatus = asyncHandler(async (req, res) => {
  const order = await stageChange.changeStage(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.json({ order });
});

const listStatusHistory = asyncHandler(async (req, res) => {
  // 404 for an order of another workspace, before any history is read.
  await service.getOrderRef(req.tenant.workspaceId, req.params.orderId);
  res.json({ history: await statusHistory.listForOrder(req.tenant.workspaceId, req.params.orderId) });
});

const previewItems = asyncHandler(async (req, res) => {
  res.json({ preview: await itemsEdit.previewItems(req.tenant.workspaceId, req.params.orderId, req.body, req) });
});

const updateItems = asyncHandler(async (req, res) => {
  res.json({ order: await present(req, await itemsEdit.updateItems(req.tenant.workspaceId, req.params.orderId, req.body, req)) });
});

const refundQuote = asyncHandler(async (req, res) => {
  res.json({ quote: await itemsEdit.refundQuote(req.tenant.workspaceId, req.params.orderId, req.body) });
});

const fulfill = asyncHandler(async (req, res) => {
  res.json({ order: await present(req, await orderFulfill.fulfill(req.tenant.workspaceId, req.params.orderId, req.body, req)) });
});

// `?as=base64` answers JSON { filename, contentType, base64 } for clients
// that can only make JSON calls (the dashboard's shared request helper).
const sendPdf = (res, pdf, name) => {
  if (res.req.query.as === 'base64') {
    return res.json({ filename: `${name}.pdf`, contentType: 'application/pdf', base64: pdf.toString('base64') });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  return res.send(pdf);
};

const waybillsPdf = asyncHandler(async (req, res) => {
  sendPdf(res, await orderDocuments.waybillsPdf(req.tenant.workspaceId, req.body), 'waybills');
});

const manifestPdf = asyncHandler(async (req, res) => {
  sendPdf(res, await orderDocuments.manifestPdf(req.tenant.workspaceId, req.body), 'manifest');
});

const invoicePdf = asyncHandler(async (req, res) => {
  const { pdf, invoiceNumber } = await buildInvoicePdf(req.tenant.workspaceId, req.params.orderId);
  sendPdf(res, pdf, `invoice-${invoiceNumber}`);
});

const importTracking = asyncHandler(async (req, res) => {
  res.json(await trackingImport.importTracking(req.tenant.workspaceId, req.body, req));
});

const bulk = asyncHandler(async (req, res) => {
  res.json(await orderBulk.bulk(req.tenant.workspaceId, req.body, req));
});

const timeline = asyncHandler(async (req, res) => {
  res.json({ events: await orderTimeline.timeline(req.tenant.workspaceId, req.params.orderId) });
});

const neighbors = asyncHandler(async (req, res) => {
  // The search the neighbours page through never matches a locked order's customer.
  const lockCtx = await orderLock.contextFor(req.tenant.workspaceId);
  const search = (conditions, bind, query) => service.applySearchAndDates(conditions, bind, query, lockCtx);
  res.json(await orderTimeline.neighbors(req.tenant.workspaceId, req.params.orderId, req.query, search));
});

const updateMeta = asyncHandler(async (req, res) => {
  // The meta only (tags, flags): no customer details in it.
  res.json({ order: await orderMeta.updateMeta(req.tenant.workspaceId, req.params.orderId, req.body, req) });
});

const listTags = asyncHandler(async (req, res) => {
  res.json({ tags: await orderMeta.listTags(req.tenant.workspaceId) });
});

const listNotes = asyncHandler(async (req, res) => {
  res.json({ notes: await orderMeta.listNotes(req.tenant.workspaceId, req.params.orderId) });
});

const addNote = asyncHandler(async (req, res) => {
  const note = await orderMeta.addNote(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.status(201).json({ note });
});

const deleteNote = asyncHandler(async (req, res) => {
  await orderMeta.deleteNote(req.tenant.workspaceId, req.params.orderId, req.params.noteId, req);
  res.status(204).end();
});

const update = asyncHandler(async (req, res) => {
  const order = await service.updateOrderLimited(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.json({ order: await present(req, order) });
});

const listShipments = asyncHandler(async (req, res) => {
  res.json({ shipments: await service.listShipments(req.tenant.workspaceId, req.params.orderId) });
});

const createShipment = asyncHandler(async (req, res) => {
  const shipment = await service.createShipment(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.status(201).json({ shipment });
});

const updateShipment = asyncHandler(async (req, res) => {
  const shipment = await service.updateShipment(
    req.tenant.workspaceId,
    req.params.orderId,
    req.params.shipmentId,
    req.body,
    req
  );
  res.json({ shipment });
});

module.exports = {
  create,
  get,
  list,
  pipeline,
  lockedSummary,
  settleLocked,
  cancel,
  confirm,
  changeStatus,
  listStatusHistory,
  waybillsPdf,
  manifestPdf,
  invoicePdf,
  importTracking,
  previewItems,
  updateItems,
  refundQuote,
  fulfill,
  manualPreview,
  manualCustomer,
  manualOptions,
  bulk,
  timeline,
  neighbors,
  updateMeta,
  listTags,
  listNotes,
  addNote,
  deleteNote,
  update,
  listShipments,
  createShipment,
  updateShipment,
};
