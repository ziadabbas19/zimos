'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./taxAdminService');

const wid = (req) => req.tenant.workspaceId;

const list = asyncHandler(async (req, res) => res.json({ taxRates: await service.listRates(wid(req)) }));
const get = asyncHandler(async (req, res) => res.json({ taxRate: await service.getRate(wid(req), req.params.taxRateId) }));
const create = asyncHandler(async (req, res) =>
  res.status(201).json({ taxRate: await service.createRate(wid(req), req.body, req) })
);
const update = asyncHandler(async (req, res) =>
  res.json({ taxRate: await service.updateRate(wid(req), req.params.taxRateId, req.body, req) })
);
const remove = asyncHandler(async (req, res) => res.json(await service.deleteRate(wid(req), req.params.taxRateId, req)));

module.exports = { list, get, create, update, remove };
