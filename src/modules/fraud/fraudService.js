'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const customerService = require('../customers/customerService');
const { resolveCursor } = require('../orders/orderService');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');

// The stages in which a flagged order still wants a decision: the COD call
// has not settled it yet. Anything past these (confirmed, shipped, cancelled,
// …) has been dealt with one way or another.
const OPEN_STAGES = ['pending_confirmation', 'needs_follow_up'];

// GET /fraud/blocklist returns at most this many rows and does not page. A
// merchant's blocklist is a hand-curated list of phones, in the tens, rarely
// the hundreds; the screen shows it whole. If a workspace ever outgrows 500
// the right move is keyset paging on (blacklisted_at, id), not a bigger cap.
const BLOCKLIST_CAP = 500;

function toFlaggedOrder(row) {
  return {
    id: row.id,
    orderNumber: row.order_number,
    createdAt: row.created_at,
    riskFlags: row.risk_flags,
    customerName: row.customer_name,
    phone: row.phone,
    totalAmount: Number(row.total_amount),
    currency: row.currency,
    confirmationState: row.confirmation_state,
    cancelled: row.cancelled,
  };
}

/**
 * Orders carrying at least one risk flag, newest first, keyset-paged exactly
 * like the orders list: `before` is the last order id of the previous page
 * and is resolved to its (created_at, id) inside the workspace.
 *
 * `cardinality(o.risk_flags) > 0` is spelled exactly as the partial index's
 * predicate (migration 089) so the planner can use it. The open filter reuses
 * STAGE_SQL — the stage expression already puts cancellation first, so an
 * order in an open stage is never a cancelled one.
 */
async function listFlaggedOrders(workspaceId, { limit = 30, before, includeResolved = false } = {}) {
  const conditions = ['o.workspace_id = $workspaceId', 'cardinality(o.risk_flags) > 0'];
  const bind = { workspaceId, limit: limit + 1 };

  if (!includeResolved) {
    conditions.push(`${STAGE_SQL} IN (${OPEN_STAGES.map((s) => `'${s}'`).join(', ')})`);
  }
  if (before) {
    const anchor = await resolveCursor(workspaceId, before, 'before');
    conditions.push('(o.created_at, o.id) < ($cursorCreatedAt::timestamptz, $cursorId::uuid)');
    bind.cursorCreatedAt = anchor.createdAt.toISOString();
    bind.cursorId = anchor.id;
  }

  const rows = await db.sequelize.query(
    `SELECT o.id,
            o.order_number,
            o.created_at,
            o.risk_flags,
            o.contact_snapshot->>'fullName' AS customer_name,
            o.contact_snapshot->>'phone' AS phone,
            o.total_amount,
            o.currency,
            o.confirmation_state,
            (${STAGE_SQL}) = 'cancelled' AS cancelled
       FROM ${ORDERS_WITH_STAGE_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $limit`,
    { bind, type: QueryTypes.SELECT }
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { orders: page.map(toFlaggedOrder), nextCursor: hasMore ? page[page.length - 1].id : null };
}

/**
 * The merchant has looked at a flagged order and is letting it through:
 * clears its risk flags and nothing else. Confirmation, payment and
 * fulfillment carry on exactly as they were.
 *
 * Idempotent: an order with no flags left (a second click, or two people
 * approving at once — the row lock makes the second one see the first's
 * write) comes back unchanged with no audit row, because nothing changed.
 */
async function approveFlaggedOrder(workspaceId, orderId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({
      where: { id: orderId, workspaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order) throw new NotFoundError('Order');

    if (order.riskFlags.length > 0) {
      const before = { riskFlags: order.riskFlags };
      await order.update({ riskFlags: [] }, { transaction });
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'order.risk_approved',
        entityType: 'Order',
        entityId: order.id,
        before,
        after: { riskFlags: [] },
        req,
        transaction,
      });
    }

    return { id: order.id, riskFlags: order.riskFlags };
  });
}

async function listBlocklist(workspaceId) {
  const customers = await db.Customer.findAll({
    where: { workspaceId, isBlacklisted: true },
    order: [
      [db.sequelize.literal('blacklisted_at DESC NULLS LAST')],
      ['id', 'DESC'],
    ],
    limit: BLOCKLIST_CAP,
  });
  return {
    entries: customers.map((c) => ({
      customerId: c.id,
      fullName: c.fullName,
      phone: c.phoneRaw || c.phoneNormalized,
      reason: c.blacklistReason,
      totalOrders: c.totalOrders,
      totalRejectedOrders: c.totalRejectedOrders,
      blockedAt: c.blacklistedAt,
    })),
  };
}

/**
 * Blocks a phone, whether or not it has ever ordered. The customer comes from
 * the same find-or-create-by-phone the checkout uses, so a later order from
 * that phone lands on this very row and carries its blacklist; the blocking
 * itself is customerService.applyBlacklist, the same write and audit as
 * PATCH /customers/:id/blacklist.
 *
 * Returns `created: true` when the phone was not blacklisted before, which
 * the controller turns into 201; re-blocking only updates the reason (200).
 */
async function blockPhone(workspaceId, { phone, reason, fullName }, req) {
  return db.sequelize.transaction(async (transaction) => {
    // Throws INVALID_PHONE (422) for a phone that does not normalize. A blank
    // fullName is stored as null — the column is nullable, and a phone that
    // never ordered has no name to give it.
    const customer = await customerService.findOrCreateByPhone(
      workspaceId,
      { phone, fullName: fullName || null },
      transaction
    );
    // Row lock, so two simultaneous blocks of the same phone agree on which
    // of them was the new one.
    await customer.reload({ transaction, lock: transaction.LOCK.UPDATE });
    const wasBlacklisted = customer.isBlacklisted;

    await customerService.applyBlacklist(customer, { isBlacklisted: true, reason }, req, transaction);

    return {
      created: !wasBlacklisted,
      entry: {
        customerId: customer.id,
        phone: customer.phoneRaw || customer.phoneNormalized,
        reason: customer.blacklistReason,
      },
    };
  });
}

module.exports = { listFlaggedOrders, approveFlaggedOrder, listBlocklist, blockPhone, BLOCKLIST_CAP };
