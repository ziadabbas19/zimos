'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const orderLock = require('../orders/orderLock');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Locked orders (orders/orderLock): the ids of the rows about an order, a
 * customer or a lost checkout that is hidden now. Their before/after are
 * shown masked (the details were written while visible and must not be read
 * now). Empty, without a query, while nothing is locked.
 */
async function hiddenRows(workspaceId, rows) {
  const hidden = new Set();
  const ctx = await orderLock.contextFor(workspaceId);
  if (orderLock.isOpenContext(ctx)) return hidden;
  // entity_id is free text: only uuids are looked up.
  const idsOf = (type) => [...new Set(rows.filter((r) => r.entityType === type && UUID.test(r.entityId || '')).map((r) => r.entityId))];
  const orderIds = idsOf('Order');
  const orders = orderIds.length ? await db.Order.findAll({ where: { id: orderIds, workspaceId }, attributes: orderLock.ORDER_ATTRIBUTES }) : [];
  const lockedOrders = await orderLock.lockedIds(ctx, orders);
  const lockedCustomers = await orderLock.lockedCustomerIds(ctx, workspaceId, idsOf('Customer'));
  const sessionsHidden = orderLock.pendingLocked(ctx);
  for (const r of rows) {
    if (
      (r.entityType === 'Order' && lockedOrders.has(r.entityId)) ||
      (r.entityType === 'Customer' && lockedCustomers.has(r.entityId)) ||
      (r.entityType === 'CheckoutSession' && sessionsHidden)
    ) {
      hidden.add(r.id);
    }
  }
  return hidden;
}

/** Workspace activity log, newest first (`before` = createdAt of the last row seen). */
const listAuditLogs = asyncHandler(async (req, res) => {
  const { limit, before, entityType, action, actorUserId, from } = req.query;
  const where = { workspaceId: req.tenant.workspaceId };
  if (before || from) where.createdAt = { ...(before ? { [Op.lt]: new Date(before) } : {}), ...(from ? { [Op.gte]: new Date(from) } : {}) };
  if (actorUserId) where.actorUserId = actorUserId;
  if (entityType) where.entityType = entityType;
  if (action) where.action = { [Op.iLike]: `${action}%` };

  const rows = await db.AuditLog.findAll({ where, order: [['createdAt', 'DESC']], limit });
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean))];
  const users = actorIds.length ? await db.User.findAll({ where: { id: actorIds }, attributes: ['id', 'fullName', 'email'] }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const hidden = await hiddenRows(req.tenant.workspaceId, rows);
  const lockOn = orderLock.enabled();

  res.json({
    logs: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      createdAt: r.createdAt,
      // A row no staff member wrote is a shopper's (a checkout): their address, not the store's.
      ipAddress: lockOn && !r.actorUserId ? null : r.ipAddress,
      actor: r.actorUserId && byId.get(r.actorUserId) ? { id: r.actorUserId, fullName: byId.get(r.actorUserId).fullName, email: byId.get(r.actorUserId).email } : null,
      before: hidden.has(r.id) ? orderLock.maskObject(r.beforeState) : r.beforeState,
      after: hidden.has(r.id) ? orderLock.maskObject(r.afterState) : r.afterState,
      ...(hidden.has(r.id) ? { contactLocked: true } : {}),
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  });
});

// Mounted at /api/v1/workspaces/:workspaceId/audit-logs
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.AUDIT_LOG_VIEW));
router.get(
  '/',
  validate({
    params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(50),
      before: Joi.date().iso().optional(),
      entityType: Joi.string().max(100).optional(),
      action: Joi.string().max(100).optional(),
      actorUserId: Joi.string().uuid().optional(),
      from: Joi.date().iso().optional(),
    }),
  }),
  listAuditLogs
);

module.exports = router;
