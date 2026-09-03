'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./returnService');

const wid = (req) => req.tenant.workspaceId;

const create = asyncHandler(async (req, res) => {
  const ret = await service.createReturn(wid(req), req.params.orderId, req.body, req);
  res.status(201).json({ return: ret });
});

const listForOrder = asyncHandler(async (req, res) => {
  res.json({ returns: await service.listReturnsForOrder(wid(req), req.params.orderId) });
});

const list = asyncHandler(async (req, res) => {
  res.json({ returns: await service.listReturns(wid(req), req.query) });
});

const moderate = asyncHandler(async (req, res) => {
  res.json({ return: await service.moderateReturn(wid(req), req.params.returnId, req.body, req) });
});

const restock = asyncHandler(async (req, res) => {
  res.json({ return: await service.restockReturn(wid(req), req.params.returnId, req) });
});

module.exports = { create, listForOrder, list, moderate, restock };
