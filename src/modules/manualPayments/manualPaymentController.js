'use strict';

const asyncHandler = require('express-async-handler');
const { AppError } = require('../../core/errors/AppError');
const service = require('./manualPaymentService');
const { normalizePayerNumber } = require('./manualPaymentValidation');
const orderLock = require('../orders/orderLock');

const wid = (req) => req.tenant.workspaceId;
const paymentToken = (req) => req.headers['x-payment-token'];

// A locked order's transfer comes without the payer's number and the screenshot (orders/orderLock).
const forStaff = async (req, manualPayment) =>
  manualPayment && (await orderLock.isOrderLocked(wid(req), req.params.orderId)) ? orderLock.maskManualPayment(manualPayment) : manualPayment;

// --- /workspaces/:workspaceId/manual-payments --------------------------------

const listMethods = asyncHandler(async (req, res) => {
  res.json({ methods: await service.listMethods(wid(req)) });
});

const createMethod = asyncHandler(async (req, res) => {
  res.status(201).json({ method: await service.createMethod(wid(req), req.body, req) });
});

const updateMethod = asyncHandler(async (req, res) => {
  res.json({ method: await service.updateMethod(wid(req), req.params.methodId, req.body, req) });
});

const deleteMethod = asyncHandler(async (req, res) => {
  await service.deleteMethod(wid(req), req.params.methodId, req);
  res.status(204).end();
});

const reorderMethods = asyncHandler(async (req, res) => {
  res.json({ methods: await service.reorderMethods(wid(req), req.body.ids, req) });
});

const getForOrder = asyncHandler(async (req, res) => {
  res.json({ manualPayment: await forStaff(req, await service.presentForStaff(wid(req), req.params.orderId)) });
});

const approve = asyncHandler(async (req, res) => {
  res.json({ manualPayment: await forStaff(req, await service.approve(wid(req), req.params.orderId, req)) });
});

const reject = asyncHandler(async (req, res) => {
  res.json({ manualPayment: await forStaff(req, await service.reject(wid(req), req.params.orderId, req.body, req)) });
});

// --- /store/:workspaceId -------------------------------------------------------

const storefrontMethods = asyncHandler(async (req, res) => {
  res.json({ methods: await service.storefrontMethods(wid(req)) });
});

const shopperStatus = asyncHandler(async (req, res) => {
  res.json({ manualPayment: await service.getForShopper(wid(req), req.params.orderId, paymentToken(req)) });
});

// multipart: `file` (the screenshot) and `payerNumber`.
const submitProof = asyncHandler(async (req, res) => {
  const payerNumber = normalizePayerNumber(req.body && req.body.payerNumber);
  if (!payerNumber) {
    throw new AppError('VALIDATION_ERROR', 'Invalid body', 422, [
      { field: 'payerNumber', message: 'must be the phone number or InstaPay account you paid from' },
    ]);
  }
  const manualPayment = await service.submitProof(wid(req), req.params.orderId, paymentToken(req), { payerNumber, file: req.file }, req);
  res.status(201).json({ manualPayment });
});

module.exports = {
  listMethods,
  createMethod,
  updateMethod,
  deleteMethod,
  reorderMethods,
  getForOrder,
  approve,
  reject,
  storefrontMethods,
  shopperStatus,
  submitProof,
};
