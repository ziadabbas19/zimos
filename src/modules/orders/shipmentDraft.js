'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { refusesHidden } = require('../../core/utils/refusesHidden');
const orderLock = require('./orderLock');

/**
 * "Save as draft" on the order's shipping card (SPEC §4.4): the shipment the
 * merchant is preparing — the courier, its address codes (the city/district
 * ids, a path of area ids, or typed names), the weight tier and the note for
 * the courier, or a manual shipment's courier name, waybill and tracking
 * link — kept on the order (orders.shipment_draft) without booking anything.
 * An order not yet confirmed can be prepared this way; booking still waits
 * for it. The order page opens its shipment form with the draft, and
 * creating a shipment clears it (shipmentLifecycle.insertShipment).
 *
 *   PUT    /workspaces/:ws/orders/:orderId/shipment-draft
 *   DELETE /workspaces/:ws/orders/:orderId/shipment-draft
 *
 * The draft comes back with the order (GET /orders/:id → shipmentDraft).
 * Nothing in it is checked against the courier: booking does that.
 */

const id = Joi.string().trim().max(100);
const params = Joi.object({ workspaceId: Joi.string().uuid().required(), orderId: Joi.string().uuid().required() });

const schemas = {
  save: {
    params,
    body: refusesHidden(Joi.object({
      carrierCode: Joi.string().trim().min(1).max(100).required(),
      address: Joi.object({
        cityId: id.allow(''),
        districtId: id.allow(''),
        path: Joi.array().items(id).max(10),
        names: Joi.array().items(Joi.string().max(200).allow('')).max(10),
      }).optional(),
      tierId: id.allow('', null).optional(),
      notes: Joi.string().max(500).allow('', null).optional(),
      manual: Joi.object({
        carrierName: Joi.string().max(100).allow(''),
        waybillNumber: Joi.string().max(100).allow(''),
        trackingUrl: Joi.string().max(500).allow(''),
      }).optional(),
    })),
  },
  remove: { params },
};

async function findOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'shipmentDraft'] });
  if (!order) throw new NotFoundError('Order');
  return order;
}

async function save(workspaceId, orderId, body, req) {
  const order = await findOrder(workspaceId, orderId);
  // Not on a locked order (402 ORDER_LOCKED): the form it comes from shows the receiver hidden.
  await orderLock.assertUnlocked(workspaceId, order.id);
  const draft = {
    carrierCode: body.carrierCode,
    ...(body.address ? { address: body.address } : {}),
    ...(body.tierId ? { tierId: body.tierId } : {}),
    ...(body.notes ? { notes: body.notes } : {}),
    ...(body.manual ? { manual: body.manual } : {}),
    savedAt: new Date().toISOString(),
    savedBy: req.user ? { id: req.user.id, name: req.user.fullName || null } : null,
  };
  const before = order.shipmentDraft;
  await order.update({ shipmentDraft: draft }, { silent: true });
  await recordAudit({
    workspaceId,
    actorUserId: req.user ? req.user.id : null,
    action: 'order.shipment_draft',
    entityType: 'Order',
    entityId: order.id,
    before: before ? { carrierCode: before.carrierCode } : null,
    after: { carrierCode: draft.carrierCode },
    req,
  });
  return draft;
}

async function remove(workspaceId, orderId, req) {
  const order = await findOrder(workspaceId, orderId);
  const before = order.shipmentDraft;
  if (!before) return;
  await order.update({ shipmentDraft: null }, { silent: true });
  await recordAudit({
    workspaceId,
    actorUserId: req.user ? req.user.id : null,
    action: 'order.shipment_draft_discard',
    entityType: 'Order',
    entityId: order.id,
    before: { carrierCode: before.carrierCode },
    after: null,
    req,
  });
}

const router = Router({ mergeParams: true });
router.put(
  '/:orderId/shipment-draft',
  validate(schemas.save),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => res.json({ shipmentDraft: await save(req.tenant.workspaceId, req.params.orderId, req.body, req) }))
);
router.delete(
  '/:orderId/shipment-draft',
  validate(schemas.remove),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => {
    await remove(req.tenant.workspaceId, req.params.orderId, req);
    res.status(204).end();
  })
);

module.exports = { router, save, remove };
