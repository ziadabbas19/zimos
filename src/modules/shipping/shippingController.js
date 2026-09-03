'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./shippingService');

const wid = (req) => req.tenant.workspaceId;

const listZones = asyncHandler(async (req, res) => res.json({ zones: await service.listZones(wid(req)) }));
const getZone = asyncHandler(async (req, res) => res.json({ zone: await service.getZone(wid(req), req.params.zoneId) }));
const createZone = asyncHandler(async (req, res) =>
  res.status(201).json({ zone: await service.createZone(wid(req), req.body, req) })
);
const updateZone = asyncHandler(async (req, res) =>
  res.json({ zone: await service.updateZone(wid(req), req.params.zoneId, req.body, req) })
);
const deleteZone = asyncHandler(async (req, res) => res.json(await service.deleteZone(wid(req), req.params.zoneId, req)));

const listRates = asyncHandler(async (req, res) =>
  res.json({ rates: await service.listRates(wid(req), req.params.zoneId) })
);
const getRate = asyncHandler(async (req, res) => res.json({ rate: await service.getRate(wid(req), req.params.rateId) }));
const createRate = asyncHandler(async (req, res) =>
  res.status(201).json({ rate: await service.createRate(wid(req), req.params.zoneId, req.body, req) })
);
const updateRate = asyncHandler(async (req, res) =>
  res.json({ rate: await service.updateRate(wid(req), req.params.rateId, req.body, req) })
);
const deleteRate = asyncHandler(async (req, res) => res.json(await service.deleteRate(wid(req), req.params.rateId, req)));

module.exports = {
  listZones,
  getZone,
  createZone,
  updateZone,
  deleteZone,
  listRates,
  getRate,
  createRate,
  updateRate,
  deleteRate,
};
