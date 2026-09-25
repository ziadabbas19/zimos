'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./paymentService');

const initialize = asyncHandler(async (req, res) => {
  const payment = await service.initializePayment(req.tenant.workspaceId, req.params.orderId, req);
  res.status(201).json({ payment });
});
const capture = asyncHandler(async (req, res) => {
  const payment = await service.capturePayment(req.tenant.workspaceId, req.params.paymentId, req);
  res.json({ payment });
});
const refund = asyncHandler(async (req, res) => {
  const result = await service.processRefund(req.tenant.workspaceId, req.params.orderId, req.body, req);
  res.status(201).json({ refund: result });
});

const listRefunds = asyncHandler(async (req, res) => {
  const refunds = await service.listRefunds(req.tenant.workspaceId, req.params.orderId);
  res.json({ refunds });
});

const sweep = require('./paymentSweepService');

const timeline = asyncHandler(async (req, res) => {
  res.json({ timeline: await sweep.timeline(req.tenant.workspaceId, req.params.orderId) });
});
const sync = asyncHandler(async (req, res) => {
  res.json({ timeline: await sweep.syncOrder(req.tenant.workspaceId, req.params.orderId) });
});

module.exports = { initialize, capture, refund, listRefunds, timeline, sync };
