'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { NotFoundError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const online = require('./onlinePaymentService');
const events = require('./paymentEventService');
const refunds = require('./gatewayRefundService');
const gateways = require('./gateways');

/**
 * Background reconciliation, for when a callback never came:
 *
 *   1. events      inbox rows whose processing failed are processed again
 *   2. inquire     open attempts on orders still inside their window are
 *                  checked with the gateway once they are a few minutes old
 *                  and not asked about recently — a payment whose webhook was
 *                  lost is recorded long before the order would expire
 *   3. expire      overdue unpaid orders: the gateway is asked first, then the
 *                  stock is released (onlinePaymentService.expireOrder, row
 *                  locked FOR UPDATE SKIP LOCKED so two sweeps, or a sweep and
 *                  a shopper, never wait on each other)
 *   4. refunds     refunds still pending are looked up by their gateway id
 *
 * Run by scripts/sweep-payments.js (a Railway cron service), and in part by
 * the merchant's "Sync payment status" button (syncOrder).
 */

// An attempt younger than this is left to its webhook.
const INQUIRE_AFTER_MS = 3 * 60 * 1000;
// Asked about this recently: skip.
const INQUIRE_EVERY_MS = 10 * 60 * 1000;

async function inquireStaleAttempts({ limit = 50 } = {}) {
  const rows = await db.sequelize.query(
    `SELECT DISTINCT p.order_id AS "orderId", p.created_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE p.status = 'initialized'
        AND p.provider_order_id IS NOT NULL
        AND p.created_at < $createdBefore::timestamptz
        AND (p.last_inquired_at IS NULL OR p.last_inquired_at < $askedBefore::timestamptz)
        AND o.cancelled_at IS NULL
      ORDER BY p.created_at
      LIMIT $limit`,
    {
      bind: {
        createdBefore: new Date(Date.now() - INQUIRE_AFTER_MS).toISOString(),
        askedBefore: new Date(Date.now() - INQUIRE_EVERY_MS).toISOString(),
        limit,
      },
      type: QueryTypes.SELECT,
    }
  );
  let unknown = 0;
  for (const row of rows) unknown += (await online.inquireOpenAttempts(row.orderId)).unknown;
  return { orders: rows.length, unknown };
}

async function expireOverdue({ limit = 50 } = {}) {
  const rows = await db.sequelize.query(
    `SELECT id FROM orders
      WHERE payment_expires_at IS NOT NULL
        AND payment_expires_at < now()
        AND cancelled_at IS NULL
        AND payment_method <> 'cod'
      ORDER BY payment_expires_at
      LIMIT $limit`,
    { bind: { limit }, type: QueryTypes.SELECT }
  );
  const outcomes = {};
  for (const row of rows) {
    let outcome;
    try {
      outcome = await online.expireOrder(row.id, { skipLocked: true });
    } catch (err) {
      outcome = 'error';
      logger.error('Payment expiry failed', { orderId: row.id, reason: err.message });
    }
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
  }
  return { seen: rows.length, outcomes };
}

/** One pass of every step. Safe to run concurrently with itself. */
async function sweepOnce({ limit = 50 } = {}) {
  const result = {};
  result.events = await events.reprocessPending({ limit });
  result.inquired = await inquireStaleAttempts({ limit });
  result.expired = await expireOverdue({ limit });
  result.refunds = await refunds.settlePendingRefunds({ limit });
  return result;
}

/**
 * Passes until a pass finds nothing left to do (or `maxPasses`), so a backlog
 * is cleared in one run and the process can exit.
 */
async function sweep({ limit = 50, maxPasses = 20 } = {}) {
  const passes = [];
  for (let i = 0; i < maxPasses; i += 1) {
    const pass = await sweepOnce({ limit });
    passes.push(pass);
    const full =
      pass.events.seen >= limit ||
      pass.inquired.orders >= limit ||
      pass.expired.seen >= limit ||
      pass.refunds.checked + pass.refunds.unanswerable >= limit;
    // A full page that changed nothing is stuck on rows that cannot be
    // answered right now: stop rather than spin on them.
    const progressed = (pass.expired.outcomes.expired || 0) > 0 || pass.events.processed > 0;
    if (!full || !progressed) break;
  }
  return { passes: passes.length, last: passes[passes.length - 1], onlineEnabled: env.payments.onlineEnabled };
}

// ------------------------------------------------------------ merchant side

const PAYMENT_FLAGS = Object.values(online.FLAGS);

/**
 * Everything about an order's money, for the order page: every attempt, every
 * gateway event, every refund, what can still be refunded, and the payment
 * alerts that need the merchant.
 */
async function timeline(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');

  const [attempts, eventRows, refundRows] = await Promise.all([
    db.Payment.findAll({ where: { orderId: order.id, workspaceId }, order: [['createdAt', 'ASC']] }),
    db.PaymentEvent.findAll({
      where: { orderId: order.id, workspaceId },
      attributes: [
        'id',
        'source',
        'kind',
        'providerCode',
        'providerTransactionId',
        'paymentId',
        'outcome',
        'error',
        'processedAt',
        'createdAt',
      ],
      order: [['createdAt', 'ASC']],
    }),
    db.Refund.findAll({ where: { orderId: order.id, workspaceId }, order: [['createdAt', 'ASC']] }),
  ]);

  const used = new Map();
  for (const r of refundRows) {
    if (!r.paymentId || !['processed', 'pending'].includes(r.status)) continue;
    used.set(r.paymentId, (used.get(r.paymentId) || 0) + Number(r.amount));
  }
  const perPayment = attempts
    .filter((p) => ['captured', 'partially_refunded'].includes(p.status) && gateways.isGateway(p.providerCode))
    .map((p) => ({ paymentId: p.id, refundable: Math.max(0, Number(p.amount) - (used.get(p.id) || 0)) }));
  const pending = refundRows.filter((r) => r.status === 'pending').reduce((s, r) => s + Number(r.amount), 0);
  const gatewayPaid = perPayment.length > 0;

  return {
    orderId: order.id,
    currency: order.currency,
    totalAmount: Number(order.totalAmount),
    amountPaid: Number(order.amountPaid),
    amountRefunded: Number(order.amountRefunded),
    pendingRefunds: pending,
    // The same rule processRefund applies.
    refundable: gatewayPaid
      ? Math.max(0, Number(order.amountPaid) - Number(order.amountRefunded) - pending)
      : Math.max(0, Number(order.totalAmount) - Number(order.amountRefunded)),
    refundVia: gatewayPaid ? 'gateway' : 'manual',
    perPayment,
    alerts: (order.riskFlags || []).filter((f) => PAYMENT_FLAGS.includes(f)),
    paymentExpiresAt: order.paymentExpiresAt,
    attempts,
    events: eventRows,
    refunds: refundRows,
  };
}

/**
 * "Sync payment status": ask the gateway about this order now — open
 * attempts, pending refunds — and expire it if it is overdue.
 */
async function syncOrder(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'] });
  if (!order) throw new NotFoundError('Order');
  const { unknown } = await online.inquireOpenAttempts(order.id);
  await refunds.settlePendingRefunds({ olderThanMs: 0, where: { orderId: order.id } });
  if (unknown === 0) await online.expireOrder(order.id);
  return { ...(await timeline(workspaceId, orderId)), unreachable: unknown > 0 };
}

module.exports = { sweep, sweepOnce, inquireStaleAttempts, expireOverdue, timeline, syncOrder, INQUIRE_AFTER_MS };
