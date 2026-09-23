'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./fraudService');

const listFlagged = asyncHandler(async (req, res) =>
  res.json(await service.listFlaggedOrders(req.tenant.workspaceId, req.query))
);
const approve = asyncHandler(async (req, res) =>
  res.json({ order: await service.approveFlaggedOrder(req.tenant.workspaceId, req.params.orderId, req) })
);
const listBlocklist = asyncHandler(async (req, res) => res.json(await service.listBlocklist(req.tenant.workspaceId)));
const block = asyncHandler(async (req, res) => {
  const { created, entry } = await service.blockPhone(req.tenant.workspaceId, req.body, req);
  res.status(created ? 201 : 200).json({ entry });
});

module.exports = { listFlagged, approve, listBlocklist, block };
