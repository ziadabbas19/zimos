'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const gatewayRuntime = require('./gatewayRuntime');
const paymentService = require('./paymentService');

/**
 * Refunds and voids the gateway reports, whoever started them.
 *
 * A refund or void is its own gateway transaction. Its payment is found by
 * the parent transaction (Paymob) or, when the gateway names none, by the
 * attempt's order reference (Kashier). The refund itself is matched, in order,
 * to:
 *
 *   1. a refund row already carrying this gateway reference — our own refund
 *      whose answer we recorded, now settled by its callback;
 *   2. a PENDING refund on the same payment with no reference yet and the same
 *      amount — our own refund whose call timed out before an answer came;
 *   3. nothing: the merchant refunded in the gateway's own dashboard. A new
 *      refund row is written with source 'gateway', so the order's totals,
 *      credit note and financial state follow the money exactly as for a
 *      refund made here.
 *
 * Settling is idempotent (paymentService.settleRefund), and a gateway refund
 * is recorded once per reference (unique index, migration 098).
 */
async function findRefundedPayment(account, tx) {
  const base = { workspaceId: account.workspaceId, providerCode: account.providerCode };
  if (tx.parentTransactionId) {
    return db.Payment.findOne({ where: { ...base, providerTransactionId: tx.parentTransactionId } });
  }
  if (tx.providerOrderId) return db.Payment.findOne({ where: { ...base, providerOrderId: tx.providerOrderId } });
  return null;
}

async function recordRefundTransaction(account, tx) {
  const payment = await findRefundedPayment(account, tx);
  if (!payment) return { outcome: 'unmatched_refund' };
  const ids = { paymentId: payment.id, orderId: payment.orderId };
  // The payment's own transaction reported as a refund is not one — a
  // notification whose unsigned event name was changed, most likely.
  if (tx.transactionId && payment.providerTransactionId && tx.transactionId === payment.providerTransactionId) {
    return { outcome: 'refund_is_payment_ignored', ...ids };
  }
  // The payment itself is not recorded yet (its notification is late, or
  // failed to process): left unprocessed for the sweep to retry, after it.
  if (!['captured', 'partially_refunded', 'refunded'].includes(payment.status)) {
    throw new Error('Refund reported before its payment was recorded');
  }

  // A void gives back the whole payment.
  const amount = tx.kind === 'void' ? Number(payment.amount) : tx.amount;
  const result = {
    status: tx.status,
    providerRefundReference: tx.transactionId,
    failureReason: tx.failureReason,
    failureCode: tx.failureCode || null,
  };

  let refund = tx.transactionId
    ? await db.Refund.findOne({ where: { paymentId: payment.id, providerRefundReference: tx.transactionId } })
    : null;
  if (!refund) {
    refund = await db.Refund.findOne({
      where: { paymentId: payment.id, status: 'pending', providerRefundReference: null, amount },
      order: [['createdAt', 'ASC']],
    });
  }

  if (refund) {
    const settled = await paymentService.settleRefund(account.workspaceId, refund.id, result);
    return { outcome: `refund_${settled.status}`, ...ids };
  }

  // Made in the gateway's dashboard. Only a finished refund moves money; a
  // failed one never happened and a pending one will be reported again.
  if (tx.status !== 'processed') return { outcome: `gateway_refund_${tx.status}_ignored`, ...ids };

  const created = await db.sequelize.transaction(async (transaction) => {
    // Re-checked under the payment lock: two deliveries of the same refund
    // callback must not both create it.
    await db.Payment.findOne({ where: { id: payment.id }, transaction, lock: transaction.LOCK.UPDATE });
    const existing = await db.Refund.findOne({
      where: { paymentId: payment.id, providerRefundReference: tx.transactionId },
      transaction,
    });
    if (existing) return null;
    const row = await db.Refund.create(
      {
        workspaceId: account.workspaceId,
        orderId: payment.orderId,
        paymentId: payment.id,
        amount,
        reason: 'Refunded in the gateway dashboard',
        status: 'pending',
        source: 'gateway',
        providerRefundReference: tx.transactionId,
      },
      { transaction }
    );
    await paymentService.applyProcessedRefund(account.workspaceId, row, null, transaction);
    return row;
  });
  return { outcome: created ? 'gateway_refund_recorded' : 'duplicate', ...ids };
}

/**
 * Asks the gateway about refunds still pending after `olderThanMs` — the
 * sweep's safety net for a refund callback that never came. A pending refund
 * with no gateway reference (its call got no answer at all) cannot be looked
 * up and is left for the merchant to check in the gateway dashboard; it is
 * counted in `unanswerable`.
 */
async function settlePendingRefunds({ olderThanMs = 5 * 60 * 1000, limit = 50, where = {} } = {}) {
  const refunds = await db.Refund.findAll({
    where: { status: 'pending', createdAt: { [Op.lt]: new Date(Date.now() - olderThanMs) }, ...where },
    include: [{ model: db.Payment, as: 'payment', required: true }],
    order: [['createdAt', 'ASC']],
    limit,
  });
  const summary = { checked: 0, settled: 0, unanswerable: 0, errors: 0 };
  for (const refund of refunds) {
    if (!refund.providerRefundReference) {
      summary.unanswerable += 1;
      continue;
    }
    summary.checked += 1;
    try {
      const ctx = await gatewayRuntime.contextFor(refund.workspaceId, refund.payment.providerCode);
      if (!ctx.adapter.inquireTransaction) continue;
      const tx = await ctx.adapter.inquireTransaction(ctx.credentials, {
        transactionId: refund.providerRefundReference,
        payment: refund.payment,
      });
      if (!tx || tx.status === 'pending') continue;
      const settled = await paymentService.settleRefund(refund.workspaceId, refund.id, {
        status: tx.status === 'processed' ? 'processed' : 'failed',
        providerRefundReference: tx.transactionId,
        failureReason: tx.failureReason,
        failureCode: tx.failureCode || null,
      });
      if (settled.status !== 'pending') summary.settled += 1;
    } catch (err) {
      summary.errors += 1;
      logger.warn('Could not check a pending refund', { refundId: refund.id, reason: err.message });
    }
  }
  return summary;
}

module.exports = { recordRefundTransaction, settlePendingRefunds };
