'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./discountAdminService');

const create = asyncHandler(async (req, res) => res.status(201).json({ discount: await service.createDiscount(req.tenant.workspaceId, req.body, req) }));
const list = asyncHandler(async (req, res) => res.json({ discounts: await service.listDiscounts(req.tenant.workspaceId) }));
const get = asyncHandler(async (req, res) => res.json({ discount: await service.getDiscount(req.tenant.workspaceId, req.params.discountId) }));
const setStatus = asyncHandler(async (req, res) => res.json({ discount: await service.setDiscountStatus(req.tenant.workspaceId, req.params.discountId, req.body.status, req) }));
const update = asyncHandler(async (req, res) => res.json({ discount: await service.updateDiscount(req.tenant.workspaceId, req.params.discountId, req.body, req) }));
const remove = asyncHandler(async (req, res) => res.json(await service.deleteDiscount(req.tenant.workspaceId, req.params.discountId, req)));

module.exports = { create, list, get, setStatus, update, remove };
