'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const wallet = require('./walletService');
const orderLock = require('../orders/orderLock');

/**
 * The pay-per-order fee taken once, when an order is confirmed
 * (ORDERS_LOCK_ENABLED, migration 718). It replaces the fee taken when the
 * order was placed (walletService.chargeOrderFee does nothing while the
 * switch is on), and is never given back: an order cancelled or returned
 * after its confirmation keeps its fee (walletService.reverseOrderFee).
 *
 * Where an order is confirmed — every path ends in one of the two setters of
 * orders/orderStateService, which call `settleOnConfirmation`:
 *   setConfirmationState → 'confirmed'  the COD queue's outcome, Confirm on the
 *       order page, PATCH /orders/:id/status to ready_to_ship (and the bulk
 *       action, order by order), a rejection corrected to confirmed, the
 *       customer's WhatsApp button. Strict: when the fee cannot be paid the
 *       confirmation is refused (402 ORDER_LOCKED) and nothing is written, so
 *       the order stays pending and locked; the WhatsApp job tells the team.
 *   setFinancialState → paid, on an order paid online (card, wallet, an
 *       approved transfer …): the money has moved, so nothing is refused.
 *       Settled now when the store is entitled; otherwise marked 'due' and
 *       settled after the commit (settleDue), or later when the balance can
 *       pay.
 *
 * One charge per order, whatever the timing:
 *   - the order row is locked by the confirming path, then the wallet row
 *     (FOR UPDATE, the transaction's last lock) — two confirmations of one
 *     order, or of two orders of one store, take turns;
 *   - under that lock: an order that already paid a fee when it was placed
 *     (before the switch, walletService's own state) or already has its
 *     confirmation fee pays nothing more;
 *   - the entry's key is order_confirm_fee:<order> and the database holds a
 *     unique index on (order_id, entry_type) for the type, so a second
 *     charge cannot be written even by a path that forgot the lock.
 * Free orders go first (cash 0, free_orders_delta -1); the cash fee is taken
 * only when the balance holds all of it: it never goes below zero.
 *
 * A funnel add-on placed as its own order pays no fee (Q14) once the order it
 * was added to is settled (its contact_lock 'unlocked', or confirmed before
 * the column existed); while that order is still pending it pays its own,
 * like any order.
 */

const FEE_TYPE = 'order_confirm_fee';

/** A balance never pays below zero: the free orders, then the balance itself. */
function canPay(walletRow, terms) {
  return wallet.freeLeft(walletRow, terms) > 0 || (walletRow ? Number(walletRow.cashBalance) : 0) >= terms.fee;
}

async function hasConfirmFee(orderId, transaction) {
  return (await db.WalletLedgerEntry.count({ where: { orderId, entryType: FEE_TYPE }, transaction })) > 0;
}

/**
 * Takes the fee for `order` (its row locked by the caller) when the store
 * can pay it. Resolves 'unlocked' (paid, a free order, nothing owed) or
 * null (cannot pay now). The wallet is locked last.
 */
async function takeFee(order, terms, { actorUserId = null } = {}, transaction) {
  // Paid when it was placed, before the switch: nothing more to take.
  if ((await wallet.orderFeeState(order.id, transaction)).charged) return 'unlocked';
  const walletRow = await wallet.lockWallet(order.workspaceId, transaction);
  if (await hasConfirmFee(order.id, transaction)) return 'unlocked';
  if (!canPay(walletRow, terms)) return null;
  const key = `${FEE_TYPE}:${order.id}`;
  const free = wallet.freeLeft(walletRow, terms) > 0;
  await wallet.writeEntry(
    walletRow,
    free
      ? { type: FEE_TYPE, delta: 0, freeDelta: -1, orderId: order.id, actorUserId, note: 'Free order', key }
      : { type: FEE_TYPE, delta: -terms.fee, orderId: order.id, actorUserId, key },
    transaction
  );
  return 'unlocked';
}

/**
 * Called by orderStateService as the order enters its confirmed stage, with
 * the order's row locked. Resolves the orders.contact_lock to write with
 * that change: 'unlocked' or (not strict only) 'due'. Strict refuses with
 * 402 ORDER_LOCKED instead of 'due'. With the switch off: 'unlocked', and no
 * fee here (the old fee was taken when the order was placed).
 */
async function settleOnConfirmation(order, { strict, actorUserId = null } = {}, transaction) {
  if (!orderLock.enabled()) return 'unlocked';
  if (order.contactLock === 'unlocked') return 'unlocked';
  const ctx = await orderLock.contextFor(order.workspaceId, { transaction });
  if (orderLock.isOpenContext(ctx)) return 'unlocked';

  if (orderLock.isFollowOn(order)) {
    // Free only when the order it follows is settled for good: its contact_lock 'unlocked', or
    // confirmed before the column existed. A pending original that merely shows now (rule (c))
    // would open this one for ever without a fee; it pays its own, as any order does (Ziad, 2026-10-25).
    const parent = await db.Order.findOne({
      where: { id: order.linkedFromOrderId, workspaceId: order.workspaceId },
      attributes: orderLock.ORDER_ATTRIBUTES,
      transaction,
    });
    if (parent && (parent.contactLock === 'unlocked' || (parent.contactLock == null && orderLock.reachedConfirmation(parent)))) return 'unlocked';
  }

  if (ctx.mode === 'pay_per_order') {
    const terms = await wallet.termsDue(order.workspaceId, transaction);
    const settled = terms ? await takeFee(order, terms, { actorUserId }, transaction) : 'unlocked';
    if (settled) return settled;
  }
  if (strict) {
    // Re-read under the wallet lock: what the refusal says is what stopped it.
    throw orderLock.lockedError(await orderLock.contextFor(order.workspaceId, { transaction }));
  }
  return 'due';
}

/**
 * The online-payment side, which takes no wallet lock in the payment's own
 * transaction (it locks the customer and the invoice after this): 'unlocked'
 * when the store is entitled now or the switch is off, else 'due', with the
 * fee taken by settleDue once the payment commits.
 */
async function markOnPayment(order, transaction) {
  if (!orderLock.enabled() || order.contactLock === 'unlocked') return 'unlocked';
  const ctx = await orderLock.contextFor(order.workspaceId, { transaction });
  if (orderLock.isOpenContext(ctx)) return 'unlocked';
  transaction.afterCommit(() =>
    settleDue(order.workspaceId, { orderIds: [order.id] }).catch((err) => logger.error(`[confirm-fee] settle after payment of ${order.id} failed: ${err.message}`))
  );
  return 'due';
}

/**
 * The store's due orders (paid online while their fee could not be paid),
 * oldest first, settled one by one while it can pay: each in its own
 * transaction, the order locked, then the wallet. Stops at the first it
 * cannot pay. A store entitled again (renewed) has them marked unlocked
 * without a fee. Run after a payment lands, after the balance grows (top-up,
 * gift, correction, free orders granted), and when the merchant asks
 * (POST /orders/locked/settle, e.g. after a fallback to pay per order). No
 * scheduled job runs it: none moves the balance's money
 * (walletNoExpiry.test.js). Resolves { settled, left }.
 */
async function settleDue(workspaceId, { orderIds = null, limit = 200, takeFees = true } = {}) {
  if (!orderLock.enabled()) return { settled: 0, left: 0 };
  // takeFees false (a renewal): only a store entitled now, whose due orders open without a fee.
  if (!takeFees && !orderLock.isOpenContext(await orderLock.contextFor(workspaceId))) return { settled: 0, left: 0 };
  // A due order cancelled since (refunded) is left as it is: no fee for it.
  const rows = await db.sequelize.query(
    `SELECT id FROM orders
      WHERE workspace_id = :workspaceId AND contact_lock = 'due'
        AND cancelled_at IS NULL AND confirmation_state <> 'rejected'
        ${orderIds ? 'AND id IN (:orderIds)' : ''}
      ORDER BY created_at ASC, id ASC
      LIMIT :limit`,
    { replacements: { workspaceId, limit, ...(orderIds ? { orderIds } : {}) }, type: QueryTypes.SELECT }
  );
  let settled = 0;
  for (const { id } of rows) {
    // eslint-disable-next-line no-await-in-loop
    const done = await db.sequelize.transaction(async (transaction) => {
      const order = await db.Order.findOne({ where: { id, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
      if (!order || order.contactLock !== 'due') return 'skip';
      const result = await settleOnConfirmation(order, { strict: false }, transaction);
      if (result !== 'unlocked') return null;
      await order.update({ contactLock: 'unlocked' }, { transaction });
      return 'unlocked';
    });
    if (done === null) break;
    if (done === 'unlocked') settled += 1;
  }
  return { settled, left: rows.length - settled };
}

/** settleDue once the caller's transaction commits; never throws. */
function settleDueAfterCommit(transaction, workspaceId) {
  if (!orderLock.enabled() || !transaction) return;
  transaction.afterCommit(() =>
    settleDue(workspaceId).catch((err) => logger.error(`[confirm-fee] settle for ${workspaceId} failed: ${err.message}`))
  );
}

/**
 * After a renewal (a charge paid, the console's activate / extend / plan
 * change): once the caller's transaction commits, a store entitled again has
 * its due orders marked unlocked, no fee taken — they would otherwise lock
 * again with the next lapse. It moves no money, so a billing sweep that
 * settles a payment may run it; a store still on pay per order keeps them
 * for its next top-up or the dashboard's settle. Never throws.
 */
function releaseDueAfterCommit(transaction, workspaceId) {
  if (!orderLock.enabled() || !transaction) return;
  transaction.afterCommit(() =>
    settleDue(workspaceId, { takeFees: false }).catch((err) => logger.error(`[confirm-fee] release for ${workspaceId} failed: ${err.message}`))
  );
}

module.exports = { FEE_TYPE, settleOnConfirmation, markOnPayment, settleDue, settleDueAfterCommit, releaseDueAfterCommit };
