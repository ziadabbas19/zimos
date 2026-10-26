'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./webhookService');
const { viewerReveals } = require('./customerData');

const wid = (req) => req.tenant.workspaceId;

const events = asyncHandler(async (req, res) => res.json(service.eventCatalogue()));

const list = asyncHandler(async (req, res) => res.json(await service.listEndpoints(wid(req))));

const create = asyncHandler(async (req, res) => res.status(201).json(await service.createEndpoint(wid(req), req.body, req)));

const update = asyncHandler(async (req, res) =>
  res.json({ endpoint: await service.updateEndpoint(wid(req), req.params.endpointId, req.body, req) })
);

const remove = asyncHandler(async (req, res) => res.json(await service.deleteEndpoint(wid(req), req.params.endpointId, req)));

const rotateSecret = asyncHandler(async (req, res) =>
  res.json(await service.rotateSecret(wid(req), req.params.endpointId, req))
);

const test = asyncHandler(async (req, res) =>
  res.json({ delivery: await service.sendTest(wid(req), req.params.endpointId, { reveal: viewerReveals(req) }) })
);

const deliveries = asyncHandler(async (req, res) =>
  res.json(await service.listDeliveries(wid(req), req.params.endpointId, req.query, { reveal: viewerReveals(req) }))
);

const redeliver = asyncHandler(async (req, res) =>
  res.json({ delivery: await service.redeliver(wid(req), req.params.endpointId, req.params.deliveryId, { reveal: viewerReveals(req) }) })
);

module.exports = { events, list, create, update, remove, rotateSecret, test, deliveries, redeliver };
