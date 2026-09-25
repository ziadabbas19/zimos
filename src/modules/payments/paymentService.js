'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { setFinancialState } = require('../orders/orderStateService');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');
const { creditNoteForRefund } = require('../invoices/invoiceService');
const gateways = require('./gateways');
const gatewayRuntime = require('./gatewayRuntime');
const { GatewayRejectedError, GatewayAuthError } = require('./gateways/gatewayErrors');

// `mock` authorises and captures in-process without moving any money, so it is
// a development/test fixture only — never a production gateway. `cod` is real:
// the money is collected by the courier on delivery.
const PROVIDERS = {
  mock: require('./providers/mockProvider'),
  cod: require('./providers/codProvider'),
};

// env.payments.defaultProvider (PAYMENTS_DEFAULT_PROVIDER) is not read on this
// path — the provider is derived from the order's own paymentMethod. It is
// still surfaced on the platform-admin services page
// (platformAdmin/systemServicesService.js), so it is not dead config.

function getProvider(code) {
  const provider = PROVIDERS[code];
  if (!provider) throw new AppError('UNKNOWN_PAYMENT_PROVIDER', `No payment provider configured for "${code}"`, 400);
  return provider;
}

async function initializePayment(workspaceId, orderId, req) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');

  // No real online gateway is wired in yet. Outside development/test the only
  // payment we can honestly take is cash on delivery — refuse rather than let
  // the mock provider mark an unpaid order as authorized in production.
  if (order.paymentMethod !== 'cod' && env.isProduction) {
    throw new AppError(
      'PAYMENT_PROVIDER_NOT_CONFIGURED',
      `No online payment gateway is configured, so "${order.paymentMethod}" cannot be taken online. Collect it on delivery or record it manually.`,
      422
    );
  }

  const providerCode = order.paymentMethod === 'cod' ? 'cod' : 'mock';
  const provider = getProvider(providerCode);
  const result = await provider.initialize({ amount: order.totalAmount, currency: order.currency, orderId: order.id });

  const payment = await db.Payment.create({
    workspaceId,
    orderId: order.id,
    providerCode,
    status: result.status,
    amount: order.totalAmount,
    currency: order.currency,
    providerReference: result.providerReference,
  });

  return payment;
}

/**
 * Captures a payment and updates the order's financialState accordingly.
 * Never captures more than the order's outstanding balance, and marks
 * partially_paid vs paid based on the running amountPaid total rather than
 * assuming a single capture always covers the whole order.
 *
 * Capturing an already-captured payment is a no-op rather than an error: a
 * double-clicked button or a retried request must never charge the order
 * twice. Anything else (initialized / failed / refunded) is refused outright.
 */
async function capturePayment(workspaceId, paymentId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const payment = await db.Payment.findOne({ where: { id: paymentId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!payment) throw new NotFoundError('Payment');

    // Idempotent: the row is locked, so the second caller sees the first
    // capture's committed state and touches nothing — no provider call, no
    // second increment of amountPaid, no financial-state transition.
    if (payment.status === 'captured') return payment;

    if (payment.status !== 'authorized') {
      throw new AppError(
        'PAYMENT_NOT_CAPTURABLE',
        `A payment can only be captured while it is authorized (this one is "${payment.status}")`,
        409
      );
    }

    const provider = getProvider(payment.providerCode);
    const result = await provider.capture({ providerReference: payment.providerReference, amount: payment.amount });

    await payment.update({ status: 'captured' }, { transaction });

    const order = await db.Order.findOne({ where: { id: payment.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    // Cap at the outstanding balance so several payments against one order can
    // never push amountPaid past what the order is actually worth.
    const outstanding = Math.max(0, Number(order.totalAmount) - Number(order.amountPaid));
    const applied = Math.min(Number(payment.amount), outstanding);
    const newAmountPaid = Number(order.amountPaid) + applied;
    const financialState = newAmountPaid >= Number(order.totalAmount) ? 'paid' : 'partially_paid';

    await order.update({ amountPaid: newAmountPaid }, { transaction });
    await setFinancialState(workspaceId, order.id, financialState, req, transaction);

    return payment;
  });
}

// A payment that money was actually taken on, and that can still give some back.
const REFUNDABLE_PAYMENT_STATUSES = ['captured', 'partially_refunded'];

/**
 * Refunds part or all of an order.
 *
 * COD, manual and mock payments keep their single-step behaviour: the refund
 * is recorded as processed in one transaction, up to what remains of the
 * order total (totalAmount - amountRefunded). Nothing leaves a gateway for
 * those — the merchant hands the money back themselves.
 *
 * An order paid through a connected gateway is refunded in two steps, so the
 * money never moves without a record of it:
 *
 *   1. In one transaction: the refund row is written as 'pending' against one
 *      captured gateway payment. What can be refunded is what was actually
 *      received and not yet given back — amountPaid - amountRefunded - the
 *      refunds still pending — and no single refund may exceed what is left on
 *      its payment. That transaction commits BEFORE the gateway is called, so
 *      a crash mid-call leaves a pending row to reconcile, not a refund nobody
 *      recorded.
 *   2. The gateway is asked outside any transaction. Its answer settles the
 *      row (settleRefund): processed, failed, or still pending when the
 *      gateway accepted it but has not finished, or did not answer at all.
 *      A pending row is settled later by the gateway's webhook or the sweep.
 *
 * `paymentId` picks the payment when an order has more than one (a duplicate
 * payment is refunded by naming it); otherwise the captured gateway payment
 * with the most left to refund is used.
 *
 * Always resolves the refund row; its `status` says which way it went.
 */
async function processRefund(workspaceId, orderId, { amount, reason, paymentId }, req) {
  const plan = await db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');

    const captured = await db.Payment.findAll({
      where: { orderId: order.id, workspaceId, status: REFUNDABLE_PAYMENT_STATUSES },
      order: [['createdAt', 'ASC']],
      transaction,
    });
    const gatewayPayments = captured.filter((p) => gateways.isGateway(p.providerCode));

    if (gatewayPayments.length === 0) {
      if (paymentId) {
        throw new AppError('REFUND_PAYMENT_INVALID', 'That payment is not a captured gateway payment on this order', 422);
      }
      const offline = captured.find((p) => p.status === 'captured') || null;
      return { refund: await refundOffline(workspaceId, order, offline, { amount, reason }, req, transaction) };
    }

    const pendingOnOrder = await sumRefunds({ orderId: order.id, status: 'pending' }, transaction);
    const eligible = Number(order.amountPaid) - Number(order.amountRefunded) - pendingOnOrder;
    if (amount > eligible) {
      throw new AppError(
        'REFUND_EXCEEDS_ELIGIBLE_AMOUNT',
        `Cannot refund ${amount}; only ${Math.max(0, eligible)} is eligible for refund`,
        422
      );
    }

    const payment = await pickPaymentToRefund(gatewayPayments, { amount, paymentId }, transaction);

    const refund = await db.Refund.create(
      {
        workspaceId,
        orderId: order.id,
        paymentId: payment.id,
        amount,
        reason,
        status: 'pending',
        source: 'merchant',
        processedByUserId: req.user.id,
      },
      { transaction }
    );

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.refund_requested',
      entityType: 'Refund',
      entityId: refund.id,
      after: { amount, reason, paymentId: payment.id, providerCode: payment.providerCode },
      req,
      transaction,
    });

    return { refund, payment };
  });

  if (!plan.payment) return plan.refund;

  let result;
  try {
    result = await gatewayRuntime.refund(workspaceId, plan.payment, amount);
  } catch (err) {
    if (err instanceof GatewayRejectedError || err instanceof GatewayAuthError) {
      result = { status: 'failed', failureReason: err.message };
    } else {
      // No definite answer: the gateway may or may not have refunded. The row
      // stays pending and is settled by the webhook or the sweep's inquiry —
      // retrying here could refund twice.
      logger.warn('Gateway refund outcome unknown; left pending', {
        workspaceId,
        refundId: plan.refund.id,
        providerCode: plan.payment.providerCode,
        reason: err.message,
      });
      result = { status: 'pending' };
    }
  }

  return settleRefund(workspaceId, plan.refund.id, result, req);
}

async function sumRefunds(where, transaction) {
  const total = await db.Refund.sum('amount', { where, transaction });
  return Number(total || 0);
}

/** How much of a payment can still be refunded: its amount less processed and pending refunds. */
async function refundableOnPayment(payment, transaction) {
  const used = await sumRefunds({ paymentId: payment.id, status: ['processed', 'pending'] }, transaction);
  return Number(payment.amount) - used;
}

async function pickPaymentToRefund(payments, { amount, paymentId }, transaction) {
  if (paymentId) {
    const payment = payments.find((p) => p.id === paymentId);
    if (!payment) {
      throw new AppError('REFUND_PAYMENT_INVALID', 'That payment is not a captured gateway payment on this order', 422);
    }
    const left = await refundableOnPayment(payment, transaction);
    if (amount > left) {
      throw new AppError(
        'REFUND_EXCEEDS_PAYMENT',
        `Cannot refund ${amount} from this payment; ${Math.max(0, left)} is left on it`,
        422
      );
    }
    return payment;
  }

  let best = null;
  let bestLeft = -1;
  for (const payment of payments) {
    const left = await refundableOnPayment(payment, transaction);
    if (left > bestLeft) {
      best = payment;
      bestLeft = left;
    }
  }
  if (amount > bestLeft) {
    // The total is eligible but spread over several payments (a duplicate):
    // one gateway refund can only draw on one of them.
    throw new AppError(
      'REFUND_EXCEEDS_PAYMENT',
      `No single payment on this order has ${amount} left to refund (at most ${Math.max(0, bestLeft)}); refund each payment separately`,
      422
    );
  }
  return best;
}

/** The order's financial state after a gateway refund settles, from money in and money out. */
function financialStateAfterRefund(order) {
  const net = Number(order.amountPaid) - Number(order.amountRefunded);
  if (net <= 0) return 'refunded';
  // A refunded duplicate leaves the order exactly paid.
  if (net >= Number(order.totalAmount)) return 'paid';
  return 'partially_refunded';
}

/**
 * Records the outcome of a gateway refund. Idempotent: a refund that already
 * left 'pending' is returned untouched, so the refund call's own answer, the
 * webhook and the sweep can all report the same result without counting it
 * twice.
 *
 * @param {object} result  { status: 'processed' | 'failed' | 'pending', providerRefundReference?, failureReason? }
 * @param {object} [req]   the merchant's request, or null for a webhook / the sweep
 */
async function settleRefund(workspaceId, refundId, result, req = null) {
  return db.sequelize.transaction(async (transaction) => {
    const refund = await db.Refund.findOne({ where: { id: refundId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!refund) throw new NotFoundError('Refund');
    if (refund.status !== 'pending') return refund;

    const reference = result.providerRefundReference ? String(result.providerRefundReference) : null;
    if (reference && !refund.providerRefundReference) refund.providerRefundReference = reference;

    if (result.status === 'pending') {
      await refund.save({ transaction });
      return refund;
    }

    if (result.status === 'failed') {
      refund.status = 'failed';
      refund.failureReason = String(result.failureReason || 'The gateway declined the refund').slice(0, 300);
      await refund.save({ transaction });
      await recordAudit({
        workspaceId,
        actorUserId: req && req.user ? req.user.id : null,
        action: 'order.refund_failed',
        entityType: 'Refund',
        entityId: refund.id,
        after: { amount: Number(refund.amount), failureReason: refund.failureReason },
        req,
        transaction,
      });
      return refund;
    }

    await applyProcessedRefund(workspaceId, refund, req, transaction);
    return refund;
  });
}

/**
 * The money has gone back: the refund is processed, the credit note issued,
 * and the payment and order totals move. Runs inside the caller's transaction
 * with the refund row locked (a 'pending' one, or a new row for a refund made
 * in the gateway's dashboard).
 */
async function applyProcessedRefund(workspaceId, refund, req, transaction) {
  const order = await db.Order.findOne({ where: { id: refund.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });

  refund.status = 'processed';
  refund.processedAt = new Date();
  await refund.save({ transaction });

  const creditNote = await creditNoteForRefund(refund, transaction);
  if (creditNote) await refund.update({ creditNoteId: creditNote.id }, { transaction });

  if (refund.paymentId) {
    const payment = await db.Payment.findOne({ where: { id: refund.paymentId }, transaction, lock: transaction.LOCK.UPDATE });
    if (payment) {
      const refundedOnPayment = await sumRefunds({ paymentId: payment.id, status: 'processed' }, transaction);
      await payment.update(
        { status: refundedOnPayment >= Number(payment.amount) ? 'refunded' : 'partially_refunded' },
        { transaction }
      );
    }
  }

  await order.update({ amountRefunded: Number(order.amountRefunded) + Number(refund.amount) }, { transaction });
  await setFinancialState(workspaceId, order.id, financialStateAfterRefund(order), req, transaction);

  await recordAudit({
    workspaceId,
    actorUserId: req && req.user ? req.user.id : null,
    action: 'order.refund',
    entityType: 'Refund',
    entityId: refund.id,
    after: { amount: Number(refund.amount), reason: refund.reason, source: refund.source },
    req,
    transaction,
  });
}

/**
 * COD / manual / mock: never allows refunding more than what remains
 * eligible (totalAmount - amountRefunded already issued), creates a credit
 * note against the order's invoice rather than mutating it, and updates
 * financialState to refunded/partially_refunded — all in the caller's
 * transaction.
 */
async function refundOffline(workspaceId, order, payment, { amount, reason }, req, transaction) {
  const eligible = Number(order.totalAmount) - Number(order.amountRefunded);
  if (amount > eligible) {
    throw new AppError('REFUND_EXCEEDS_ELIGIBLE_AMOUNT', `Cannot refund ${amount}; only ${eligible} is eligible for refund`, 422);
  }

  const refund = await db.Refund.create(
    {
      workspaceId,
      orderId: order.id,
      paymentId: payment ? payment.id : null,
      amount,
      reason,
      status: 'pending',
      source: 'merchant',
      processedByUserId: req.user.id,
    },
    { transaction }
  );

  if (payment) {
    const provider = getProvider(payment.providerCode);
    await provider.refund({ providerReference: payment.providerReference, amount });
  }
  await refund.update({ status: 'processed', processedAt: new Date() }, { transaction });

  const creditNote = await creditNoteForRefund(refund, transaction);
  if (creditNote) await refund.update({ creditNoteId: creditNote.id }, { transaction });

  const newAmountRefunded = Number(order.amountRefunded) + Number(amount);
  const financialState = newAmountRefunded >= Number(order.totalAmount) ? 'refunded' : 'partially_refunded';
  await order.update({ amountRefunded: newAmountRefunded }, { transaction });
  await setFinancialState(workspaceId, order.id, financialState, req, transaction);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'order.refund',
    entityType: 'Refund',
    entityId: refund.id,
    after: { amount, reason },
    req,
    transaction,
  });

  return refund;
}

async function listRefunds(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id'] });
  if (!order) throw new NotFoundError('Order');
  return db.Refund.findAll({ where: { workspaceId, orderId }, order: [['createdAt', 'ASC']] });
}

module.exports = {
  REFUNDABLE_PAYMENT_STATUSES,
  initializePayment,
  capturePayment,
  processRefund,
  settleRefund,
  applyProcessedRefund,
  financialStateAfterRefund,
  listRefunds,
};
