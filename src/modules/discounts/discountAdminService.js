'use strict';

const db = require('../../db/models');
const { scoped } = require('../../core/utils/scopedRepository');
const { recordAudit } = require('../audit/auditService');

async function createDiscount(workspaceId, data, req) {
  const discount = await db.Discount.create({ ...data, workspaceId });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'discount.create', entityType: 'Discount', entityId: discount.id, after: data, req });
  return discount;
}

async function listDiscounts(workspaceId) {
  return db.Discount.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']] });
}

async function getDiscount(workspaceId, discountId) {
  return scoped(db.Discount, workspaceId).findByPkOrThrow(discountId);
}

async function setDiscountStatus(workspaceId, discountId, status, req) {
  const discount = await scoped(db.Discount, workspaceId).findByPkOrThrow(discountId);
  await discount.update({ status });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'discount.status_change', entityType: 'Discount', entityId: discount.id, after: { status }, req });
  return discount;
}

async function updateDiscount(workspaceId, discountId, data, req) {
  const discount = await scoped(db.Discount, workspaceId).findByPkOrThrow(discountId);
  const before = discount.toJSON();
  await discount.update(data);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'discount.update', entityType: 'Discount', entityId: discount.id, before, after: discount.toJSON(), req });
  return discount;
}

/**
 * A discount that has ever been redeemed is financial history — discount_
 * redemptions rows tie it to real orders — so DELETE archives it (drops it
 * out of every evaluate() path, which only ever matches status 'active')
 * rather than removing the row.
 */
async function deleteDiscount(workspaceId, discountId, req) {
  const discount = await scoped(db.Discount, workspaceId).findByPkOrThrow(discountId);
  const before = discount.toJSON();
  await discount.update({ status: 'archived' });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'discount.delete', entityType: 'Discount', entityId: discount.id, before, after: { status: 'archived' }, req });
  return { archived: true, id: discount.id };
}

module.exports = { createDiscount, listDiscounts, getDiscount, setDiscountStatus, updateDiscount, deleteDiscount };
