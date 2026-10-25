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

// What a row about a gift card, a shipment or a blacklist entry keeps of the customer: only these
// keys of its before/after are hidden, the rest (its status, amounts, waybill) shows.
const CUSTOMER_KEYS = {
  GiftCard: ['recipientName', 'recipientEmail', 'message'],
  Shipment: ['carrierResponse', 'trackingState'],
  BlockedEntry: ['value', 'label'],
};

/** `state` with `keys` hidden as orderLock hides them (an empty value stays empty). */
function maskKeys(state, keys) {
  if (!state || typeof state !== 'object') return state;
  const picked = Object.fromEntries(keys.filter((k) => k in state).map((k) => [k, state[k]]));
  return { ...state, ...orderLock.maskObject(picked) };
}

/**
 * Locked orders (orders/orderLock): for each row whose before/after carries
 * a customer who is hidden now (the details were written while visible and
 * must not be read now), how to show its states: a row about a locked order,
 * a hidden customer or a lost checkout while those are hidden, masked whole;
 * a row about a gift card or a shipment of a locked order, or a blacklist
 * entry of a hidden customer (fraud/blockedEntries.hiddenEntryTest), with
 * the customer's keys masked. A gift card or shipment deleted since is not
 * looked up. Empty, without a query, while nothing is locked.
 */
async function hiddenRows(workspaceId, rows) {
  const hidden = new Map();
  const ctx = await orderLock.contextFor(workspaceId);
  if (orderLock.isOpenContext(ctx)) return hidden;
  // entity_id is free text: only uuids are looked up.
  const idsOf = (type) => [...new Set(rows.filter((r) => r.entityType === type && UUID.test(r.entityId || '')).map((r) => r.entityId))];
  const byId = (model, ids) => (ids.length ? model.findAll({ where: { id: ids, workspaceId }, attributes: ['id', 'orderId'] }) : []);
  const [giftCards, shipments] = await Promise.all([byId(db.GiftCard, idsOf('GiftCard')), byId(db.Shipment, idsOf('Shipment'))]);
  // A gift card or a shipment is hidden with the order it belongs to.
  const orderOf = new Map([...giftCards, ...shipments].filter((x) => x.orderId).map((x) => [x.id, x.orderId]));
  const orderIds = [...new Set([...idsOf('Order'), ...orderOf.values()])];
  const orders = orderIds.length ? await db.Order.findAll({ where: { id: orderIds, workspaceId }, attributes: orderLock.ORDER_ATTRIBUTES }) : [];
  const lockedOrders = await orderLock.lockedIds(ctx, orders);
  const lockedCustomers = await orderLock.lockedCustomerIds(ctx, workspaceId, idsOf('Customer'));
  const sessionsHidden = orderLock.pendingLocked(ctx);
  const entryState = (r) => r.afterState || r.beforeState;
  const entryHidden = await require('../fraud/blockedEntries').hiddenEntryTest(
    ctx,
    workspaceId,
    rows.filter((r) => r.entityType === 'BlockedEntry').map(entryState)
  );
  const whole = (state) => orderLock.maskObject(state);
  for (const r of rows) {
    const keys = CUSTOMER_KEYS[r.entityType];
    if (
      (r.entityType === 'Order' && lockedOrders.has(r.entityId)) ||
      (r.entityType === 'Customer' && lockedCustomers.has(r.entityId)) ||
      (r.entityType === 'CheckoutSession' && sessionsHidden)
    ) {
      hidden.set(r.id, whole);
    } else if (
      ((r.entityType === 'GiftCard' || r.entityType === 'Shipment') && lockedOrders.has(orderOf.get(r.entityId))) ||
      (r.entityType === 'BlockedEntry' && entryHidden(entryState(r)))
    ) {
      hidden.set(r.id, (state) => maskKeys(state, keys));
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
      before: hidden.has(r.id) ? hidden.get(r.id)(r.beforeState) : r.beforeState,
      after: hidden.has(r.id) ? hidden.get(r.id)(r.afterState) : r.afterState,
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
