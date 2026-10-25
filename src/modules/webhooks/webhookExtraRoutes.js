'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { attemptDelivery } = require('./webhookDispatcher');
const { resendOrders } = require('./webhookFanout');

/**
 * The store-wide delivery log and "resend order to webhook" (SPEC §16.1).
 * Mounted by webhookRoutes.js, behind its authenticate → resolveTenant →
 * webhooks.manage, and before its `/:endpointId` routes.
 */

const router = Router({ mergeParams: true });
const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };

const STATUS_GROUPS = { succeeded: ['delivered'], failed: ['failed', 'exhausted'], pending: ['pending'] };

const view = (delivery) => ({
  id: delivery.id,
  endpointId: delivery.endpointId,
  url: delivery.endpoint ? delivery.endpoint.url : null,
  eventId: delivery.eventId,
  eventType: delivery.eventType,
  status: delivery.status,
  attemptCount: delivery.attemptCount,
  nextAttemptAt: delivery.nextAttemptAt,
  lastResponseStatus: delivery.lastResponseStatus,
  lastError: delivery.lastError,
  payload: delivery.payload,
  createdAt: delivery.createdAt,
  updatedAt: delivery.updatedAt,
});

// GET /webhooks/deliveries?status=all|succeeded|failed|pending&endpointId=&before=&limit=
router.get(
  '/deliveries',
  validate({
    params: Joi.object(ws),
    query: Joi.object({
      status: Joi.string().valid('all', 'succeeded', 'failed', 'pending').default('all'),
      endpointId: uuid.optional(),
      eventType: Joi.string().max(100).optional(),
      before: Joi.date().iso().optional(),
      limit: Joi.number().integer().min(1).max(100).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, endpointId, eventType, before, limit } = req.query;
    const where = { workspaceId: req.tenant.workspaceId };
    if (status !== 'all') where.status = STATUS_GROUPS[status];
    if (endpointId) where.endpointId = endpointId;
    if (eventType) where.eventType = eventType;
    if (before) where.createdAt = { [Op.lt]: before };
    const rows = await db.WebhookDelivery.findAll({
      where,
      include: [{ model: db.WebhookEndpoint, as: 'endpoint', attributes: ['id', 'url'] }],
      order: [['createdAt', 'DESC']],
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    res.json({
      deliveries: page.map(view),
      nextCursor: rows.length > limit ? page[page.length - 1].createdAt.toISOString() : null,
    });
  })
);

/**
 * A stored payload was written while its subject was visible: sent again
 * by hand it is refused (402 ORDER_LOCKED) when the order, the customer or
 * the lost checkout it is about is locked now (orders/orderLock).
 */
async function assertSendable(workspaceId, delivery) {
  const orderLock = require('../orders/orderLock');
  if (!orderLock.enabled()) return;
  const data = (delivery.payload && delivery.payload.data) || {};
  const orderId = (data.order && data.order.id) || data.orderId || null;
  if (orderId) await orderLock.assertUnlocked(workspaceId, orderId);
  else if (data.customer && data.customer.id) await orderLock.assertCustomerVisible(workspaceId, data.customer.id);
  else if (String(delivery.eventType).startsWith('checkout.')) await orderLock.assertPendingOpen(workspaceId);
}

// POST /webhooks/deliveries/:deliveryId/resend — send this delivery again now.
router.post(
  '/deliveries/:deliveryId/resend',
  validate({ params: Joi.object({ ...ws, deliveryId: uuid.required() }) }),
  asyncHandler(async (req, res) => {
    const delivery = await db.WebhookDelivery.findOne({ where: { id: req.params.deliveryId, workspaceId: req.tenant.workspaceId } });
    if (!delivery) throw new NotFoundError('WebhookDelivery');
    await assertSendable(req.tenant.workspaceId, delivery);
    const sent = await attemptDelivery(delivery.id);
    const fresh = await db.WebhookDelivery.findByPk(sent.id, {
      include: [{ model: db.WebhookEndpoint, as: 'endpoint', attributes: ['id', 'url'] }],
    });
    res.json({ delivery: view(fresh) });
  })
);

// POST /webhooks/resend-orders { orderIds: [...], endpointId? } — from the order page and bulk actions.
router.post(
  '/resend-orders',
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      orderIds: Joi.array().items(uuid).min(1).max(100).unique().required(),
      endpointId: uuid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    if (req.body.endpointId) {
      const endpoint = await db.WebhookEndpoint.findOne({ where: { id: req.body.endpointId, workspaceId }, attributes: ['id'] });
      if (!endpoint) throw new NotFoundError('WebhookEndpoint');
    }
    const result = await resendOrders(workspaceId, req.body.orderIds, { endpointId: req.body.endpointId || null });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'webhook.resend_orders',
      entityType: 'WebhookEndpoint',
      entityId: req.body.endpointId || null,
      after: { orderIds: req.body.orderIds, deliveries: result.deliveries },
      req,
    });
    res.json(result);
  })
);

module.exports = router;
