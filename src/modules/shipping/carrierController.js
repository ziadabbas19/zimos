'use strict';

const asyncHandler = require('express-async-handler');
const accounts = require('./carrierAccountService');
const shipments = require('./carrierShipmentService');
const webhooks = require('./carrierWebhookService');

const wid = (req) => req.tenant.workspaceId;

// --- /workspaces/:workspaceId/carriers ---------------------------------------

const list = asyncHandler(async (req, res) => res.json(await accounts.listCarriers(wid(req))));

const connect = asyncHandler(async (req, res) =>
  res.json(await accounts.connect(wid(req), req.params.code, req.body, req))
);

const disconnect = asyncHandler(async (req, res) =>
  res.json(await accounts.disconnect(wid(req), req.params.code, req))
);

const cities = asyncHandler(async (req, res) =>
  res.json(await accounts.getCities(wid(req), req.params.code, req.query))
);

// --- /workspaces/:workspaceId/orders/:orderId/shipments/:shipmentId ----------

const sync = asyncHandler(async (req, res) =>
  res.json(await shipments.syncShipment(wid(req), req.params.orderId, req.params.shipmentId))
);

const label = asyncHandler(async (req, res) => {
  const { pdf, filename } = await shipments.getShipmentLabel(wid(req), req.params.orderId, req.params.shipmentId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  res.send(pdf);
});

// --- /webhooks/carriers/:code/:token (public) --------------------------------

const webhook = asyncHandler(async (req, res) => {
  const job = await webhooks.accept(req.params.code, req.params.token, req);
  res.json({ received: true });
  if (job) job();
});

module.exports = { list, connect, disconnect, cities, sync, label, webhook };
