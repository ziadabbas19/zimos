'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { acceptanceOf } = require('../orders/orderAccepted');

/**
 * Where an order stands in the merchant's till or kitchen, as that system
 * reports it (PUBLIC_API_ACK_ENABLED, migration 717):
 *
 *   PUT /public/orders/:orderId/pos-status { status, reference? }
 *
 *   status     received | preparing | ready | completed
 *   reference  the order's number in that system (optional, kept until replaced)
 *
 * A note beside the order, never its stage: nothing in Zimos moves because
 * of it — "ready" does not ship and "completed" does not deliver; those stay
 * the shipment's and the courier's. It is set only on an accepted order of
 * the key's own store (orders/orderAccepted.js), in any order of statuses:
 * the till is the one that knows. One status per order, shared by the store's
 * keys (the last write wins; api_key_id says which key wrote it). Integrations
 * read it back as `pos` on the order (publicOrderOptions.serializeOrders).
 */

const STATUSES = ['received', 'preparing', 'ready', 'completed'];

const view = (row) => (row ? { status: row.status, reference: row.reference || null, updatedAt: row.updatedAt } : null);

async function setStatus(workspaceId, orderId, { status, reference }, req) {
  const acceptance = await acceptanceOf(workspaceId, orderId);
  if (!acceptance) throw new NotFoundError('Order');
  if (!acceptance.accepted) {
    throw new AppError('ORDER_NOT_ACCEPTED', 'Only an accepted order (confirmed, or paid online) has a kitchen status', 409);
  }
  return db.sequelize.transaction(async (transaction) => {
    const before = await db.OrderPosStatus.findOne({ where: { orderId, workspaceId }, transaction });
    const previous = before ? before.status : null;
    // One statement, so two reports arriving together never collide on the order's row.
    const [row] = await db.OrderPosStatus.upsert(
      {
        orderId,
        workspaceId,
        status,
        apiKeyId: req.apiKey ? req.apiKey.id : null,
        reference: reference !== undefined ? reference || null : before ? before.reference : null,
      },
      { transaction, returning: true }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.pos_status',
      entityType: 'Order',
      entityId: orderId,
      before: previous ? { status: previous } : null,
      after: { status: row.status, reference: row.reference || null, apiKeyPrefix: req.apiKey ? req.apiKey.keyPrefix : null },
      req,
      transaction,
    });
    return view(row);
  });
}

/** orderId → { status, reference, updatedAt } for these orders of the store. */
async function statusesFor(workspaceId, orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = await db.OrderPosStatus.findAll({ where: { workspaceId, orderId: orderIds } });
  return new Map(rows.map((r) => [r.orderId, view(r)]));
}

module.exports = { STATUSES, setStatus, statusesFor };
