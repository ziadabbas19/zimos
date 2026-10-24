'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM, latestShipmentJoin } = require('./orderStage');
const realtimeEvents = require('../realtime/realtimeEvents');

/**
 * The record of an order's moves between pipeline stages.
 *
 * The stage is derived (orderStage.js) from columns several modules write, so
 * there is no single assignment to hook. Instead, whoever has just changed an
 * order's state calls `sync` in the same transaction: it works the stage out
 * again, compares it with the last row written for the order, and writes a
 * row when the two differ. Calling it when nothing moved writes nothing, so
 * the callers do not have to know whether their change crossed a stage
 * boundary — and two callers in one transaction cannot record a move twice.
 */

const ACTOR_TYPES = ['user', 'system', 'carrier', 'customer', 'api'];

/**
 * The order's stage as the given transaction sees it; with
 * `withoutShipmentId`, the stage it will have once that shipment is cancelled.
 */
async function stageOf(orderId, transaction = null, { withoutShipmentId = null } = {}) {
  const from = withoutShipmentId ? `orders o${latestShipmentJoin(' AND s.id <> $withoutShipmentId')}` : ORDERS_WITH_STAGE_FROM;
  const rows = await db.sequelize.query(
    `SELECT ${STAGE_SQL} AS stage
       FROM ${from}
      WHERE o.id = $orderId`,
    { bind: withoutShipmentId ? { orderId, withoutShipmentId } : { orderId }, type: QueryTypes.SELECT, ...(transaction ? { transaction } : {}) }
  );
  return rows.length > 0 ? rows[0].stage : null;
}

/** Who is behind a request: a signed-in user, an API key, or `fallback`. */
function actorFrom(req, fallback = 'system') {
  if (req && req.user) return { actorType: 'user', actorId: req.user.id };
  if (req && req.apiKey) return { actorType: 'api', actorId: req.apiKey.id };
  return { actorType: fallback, actorId: null };
}

async function lastRow(orderId, transaction) {
  return db.OrderStatusHistory.findOne({
    where: { orderId },
    order: [['id', 'DESC']],
    ...(transaction ? { transaction } : {}),
  });
}

/**
 * Writes a history row if the order's stage differs from the last one
 * recorded. `guard(from, to)` — when given — is called before the row is
 * written and may throw to refuse the move (the caller's transaction then
 * rolls the change back).
 *
 * @returns {Promise<object|null>} the new row, or null when nothing moved
 */
async function sync(workspaceId, orderId, { transaction = null, actorType = 'system', actorId = null, reason = null, guard = null } = {}) {
  const current = await stageOf(orderId, transaction);
  if (!current) return null;
  const last = await lastRow(orderId, transaction);
  const from = last ? last.toStatus : null;
  if (from === current) return null;
  if (guard && from) guard(from, current);
  const row = await db.OrderStatusHistory.create(
    {
      workspaceId,
      orderId,
      fromStatus: from,
      toStatus: current,
      actorType: ACTOR_TYPES.includes(actorType) ? actorType : 'system',
      actorId,
      reason: reason ? String(reason).slice(0, 500) : null,
    },
    transaction ? { transaction } : undefined
  );
  // the platform-wide delivery numbers follow every stage move (never throws).
  // A move (not the order's first stage) is a live update to the dashboard, with REALTIME_ENABLED only.
  if (from) await realtimeEvents.record(transaction, 'order.stage_changed', { workspaceId, orderId });
  return row;
}

/** An order's history, oldest first, each row carrying its actor's name. */
async function listForOrder(workspaceId, orderId) {
  const rows = await db.OrderStatusHistory.findAll({ where: { workspaceId, orderId }, order: [['id', 'ASC']] });
  const userIds = [...new Set(rows.filter((r) => r.actorType === 'user' && r.actorId).map((r) => r.actorId))];
  const users = userIds.length
    ? await db.User.findAll({ where: { id: userIds }, attributes: ['id', 'fullName'] })
    : [];
  const names = new Map(users.map((u) => [u.id, u.fullName]));
  return rows.map((r) => ({
    id: String(r.id),
    fromStatus: r.fromStatus,
    toStatus: r.toStatus,
    actorType: r.actorType,
    actorId: r.actorId,
    actorName: r.actorType === 'user' ? names.get(r.actorId) || null : null,
    reason: r.reason,
    createdAt: r.createdAt,
  }));
}

module.exports = { ACTOR_TYPES, stageOf, lastRow, actorFrom, sync, listForOrder };
