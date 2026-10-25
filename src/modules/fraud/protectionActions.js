'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const blockedEntries = require('./blockedEntries');

/**
 * The fraud screen's "Block and cancel" and its Statistics tab (SPEC §5.7).
 */

const BLOCK_REASON_MAX = 300;

/**
 * POST /fraud/flagged-orders/:orderId/block — the merchant has decided the
 * order is fake: its phone is blocked from ordering, its IP (when recorded)
 * from ordering and from visiting, and the order is cancelled through the
 * orders module's own cancel (stock back, courier booking cancelled, history
 * row). An order already cancelled is only blocked.
 */
async function blockAndCancel(workspaceId, orderId, { reason, acknowledgeManualCancel = false } = {}, req) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  // Blocking copies the phone and IP into the blocklist, which lists them: not
  // for a locked order (402 ORDER_LOCKED, orders/orderLock). Cancelling it alone still works.
  await require('../orders/orderLock').assertUnlocked(workspaceId, order);
  const why = String(reason || `Blocked from order ${order.orderNumber}`).slice(0, BLOCK_REASON_MAX);

  // Cancel first: if the order cannot be cancelled (shipped, courier needs an
  // acknowledgement) nothing is blocked and the merchant sees why.
  const orderService = require('../orders/orderService');
  let cancelled = false;
  if (!order.cancelledAt) {
    await orderService.cancelOrder(workspaceId, orderId, { reason: why, acknowledgeManualCancel }, req);
    cancelled = true;
  }

  const entries = [];
  const phone = order.contactSnapshot && order.contactSnapshot.phone;
  if (phone) {
    const added = await blockedEntries.addEntry(workspaceId, { type: 'phone', value: phone, scopes: ['orders'], reason: why }, req);
    entries.push(...added.entries);
  }
  if (order.ipAddress) {
    const added = await blockedEntries.addEntry(
      workspaceId,
      { type: 'ip', value: order.ipAddress, scopes: ['orders', 'visit'], reason: why },
      req
    );
    entries.push(...added.entries);
  }

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'order.blocked_and_cancelled',
    entityType: 'Order',
    entityId: order.id,
    after: { cancelled, entries: entries.map((e) => ({ type: e.type, scope: e.scope })) },
    req,
  });
  return { order: { id: order.id, orderNumber: order.orderNumber, cancelled: true }, entries };
}

/**
 * GET /fraud/stats?from=&to= — what the protection layer did in the period
 * (default: the last 30 days).
 *
 *   prevented        orders refused at checkout (audit `order.blocked`), by reason
 *   blockedCancelled orders the merchant blocked and cancelled
 *   flagged          orders placed carrying a risk flag
 *   highRisk         orders scored `high`
 *   estimatedSaved   prevented + blockedCancelled, each costed at a round trip
 *                    of the store's average shipping fee over the last 90 days
 */
async function stats(workspaceId, { from, to } = {}) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const bind = { workspaceId, start: start.toISOString(), end: end.toISOString() };

  const [refusals, [orders], [shipping], blocked, [currencyRow]] = await Promise.all([
    db.sequelize.query(
      `SELECT flag, COUNT(*)::int AS count
         FROM audit_logs a
         CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(a.after_state->'flags', '[]'::jsonb)) AS flag
        WHERE a.workspace_id = $workspaceId AND a.action = 'order.blocked'
          AND a.created_at >= $start::timestamptz AND a.created_at <= $end::timestamptz
        GROUP BY flag`,
      { bind, type: QueryTypes.SELECT }
    ),
    db.sequelize.query(
      `SELECT
          (SELECT COUNT(*)::int FROM audit_logs a
            WHERE a.workspace_id = $workspaceId AND a.action = 'order.blocked'
              AND a.created_at >= $start::timestamptz AND a.created_at <= $end::timestamptz) AS prevented,
          (SELECT COUNT(*)::int FROM audit_logs a
            WHERE a.workspace_id = $workspaceId AND a.action = 'order.blocked_and_cancelled'
              AND a.created_at >= $start::timestamptz AND a.created_at <= $end::timestamptz) AS blocked_cancelled,
          COUNT(*) FILTER (WHERE cardinality(o.risk_flags) > 0)::int AS flagged,
          COUNT(*) FILTER (WHERE o.risk_level = 'high')::int AS high_risk,
          COUNT(*)::int AS orders
         FROM orders o
        WHERE o.workspace_id = $workspaceId
          AND o.created_at >= $start::timestamptz AND o.created_at <= $end::timestamptz`,
      { bind, type: QueryTypes.SELECT }
    ),
    db.sequelize.query(
      `SELECT COALESCE(ROUND(AVG(o.shipping_amount)), 0)::bigint AS average
         FROM orders o
        WHERE o.workspace_id = $workspaceId AND o.shipping_amount > 0
          AND o.created_at >= NOW() - interval '90 days'`,
      { bind: { workspaceId }, type: QueryTypes.SELECT }
    ),
    db.BlockedEntry.count({ where: { workspaceId } }),
    db.sequelize.query(`SELECT default_currency AS currency FROM workspaces WHERE id = $workspaceId`, {
      bind: { workspaceId },
      type: QueryTypes.SELECT,
    }),
  ]);

  const averageShipping = Number(shipping.average) || 0;
  const stopped = orders.prevented + orders.blocked_cancelled;
  const byReason = {};
  for (const row of refusals) byReason[row.flag] = row.count;

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    orders: orders.orders,
    prevented: orders.prevented,
    preventedByReason: byReason,
    blockedCancelled: orders.blocked_cancelled,
    flagged: orders.flagged,
    highRisk: orders.high_risk,
    blockedEntries: blocked,
    // Money in minor units, as a string, like every amount in the API.
    averageShippingAmount: String(averageShipping),
    estimatedSavedAmount: String(stopped * averageShipping * 2),
    currency: (currencyRow && currencyRow.currency) || 'EGP',
  };
}

module.exports = { blockAndCancel, stats };
