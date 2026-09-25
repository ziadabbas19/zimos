'use strict';

const asyncHandler = require('express-async-handler');
const accounts = require('./gatewayAccountService');
const methods = require('./paymentMethodsService');
const online = require('./onlinePaymentService');
const events = require('./paymentEventService');

const wid = (req) => req.tenant.workspaceId;
const paymentToken = (req) => req.headers['x-payment-token'];

// --- /workspaces/:workspaceId/payments ---------------------------------------

const listGateways = asyncHandler(async (req, res) => res.json(await accounts.listGateways(wid(req))));

const connectGateway = asyncHandler(async (req, res) =>
  res.json(await accounts.connect(wid(req), req.params.code, req.body, req))
);

const disconnectGateway = asyncHandler(async (req, res) =>
  res.json(await accounts.disconnect(wid(req), req.params.code, req))
);

const listMethods = asyncHandler(async (req, res) => res.json(await methods.listForDashboard(wid(req))));

const updateMethods = asyncHandler(async (req, res) =>
  res.json(await methods.updateForDashboard(wid(req), req.body, req))
);

const previewToken = asyncHandler(async (req, res) => res.status(201).json(methods.issuePreviewToken(wid(req))));

// --- /store/:workspaceId (public) ----------------------------------------------

const storefrontMethods = asyncHandler(async (req, res) => {
  const preview = methods.isPreviewRequest(req, req.publicWorkspace.id);
  res.json({ methods: await methods.storefrontMethods(req.publicWorkspace, { preview }), preview });
});

const shopperStatus = asyncHandler(async (req, res) => {
  const payment = await online.getShopperStatus(wid(req), req.params.orderId, paymentToken(req), {
    refresh: req.query.refresh === '1' || req.query.refresh === 'true',
    req,
  });
  res.json({ payment });
});

const shopperReturn = asyncHandler(async (req, res) => {
  const payment = await online.handleReturn(wid(req), req.params.orderId, paymentToken(req), req.body.query, req);
  res.json({ payment });
});

const shopperRetry = asyncHandler(async (req, res) => {
  const payment = await online.retry(wid(req), req.params.orderId, paymentToken(req), req.body, req);
  res.json({ payment });
});

const shopperSwitchToCod = asyncHandler(async (req, res) => {
  const payment = await online.switchToCod(wid(req), req.params.orderId, paymentToken(req), req);
  res.json({ payment });
});

// --- /webhooks/payments/:code/:token (public) -----------------------------------

const webhook = asyncHandler(async (req, res) => {
  res.json(await events.acceptWebhook(req.params.code, req.params.token, req));
});

module.exports = {
  listGateways,
  connectGateway,
  disconnectGateway,
  listMethods,
  updateMethods,
  previewToken,
  storefrontMethods,
  shopperStatus,
  shopperReturn,
  shopperRetry,
  shopperSwitchToCod,
  webhook,
};
