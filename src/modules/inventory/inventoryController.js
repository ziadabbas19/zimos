'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./inventoryService');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');

const getStock = asyncHandler(async (req, res) => {
  const variant = await db.ProductVariant.findOne({ where: { id: req.params.variantId, workspaceId: req.tenant.workspaceId } });
  if (!variant) throw new NotFoundError('ProductVariant');
  res.json({
    variantId: variant.id,
    stockOnHand: variant.stockOnHand,
    reservedStock: variant.reservedStock,
    availableStock: variant.availableStock(),
  });
});

const adjust = asyncHandler(async (req, res) => {
  const variant = await service.adjustStock({
    workspaceId: req.tenant.workspaceId,
    variantId: req.params.variantId,
    delta: req.body.delta,
    reason: req.body.reason,
    actorUserId: req.user.id,
  });
  res.json({ variantId: variant.id, stockOnHand: variant.stockOnHand, reservedStock: variant.reservedStock });
});

const restock = asyncHandler(async (req, res) => {
  const variant = await service.restock({
    workspaceId: req.tenant.workspaceId,
    variantId: req.params.variantId,
    quantity: req.body.quantity,
    reason: req.body.reason || 'Manual restock',
    actorUserId: req.user.id,
  });
  res.json({ variantId: variant.id, stockOnHand: variant.stockOnHand, reservedStock: variant.reservedStock });
});

module.exports = { getStock, adjust, restock };
