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

module.exports = { initialize, capture, refund };
