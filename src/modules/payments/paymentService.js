'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { setFinancialState } = require('../orders/orderStateService');
const { recordAudit } = require('../audit/auditService');
const { createInvoiceForOrder, creditNoteForRefund } = require('../invoices/invoiceService');

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

/**
 * Processes a refund: never allows refunding more than what remains
 * eligible (totalAmount - amountRefunded already issued), creates a credit
 * note against the order's invoice rather than mutating it, and updates
 * financialState to refunded/partially_refunded.
 */
async function processRefund(workspaceId, orderId, { amount, reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');

    const eligible = Number(order.totalAmount) - Number(order.amountRefunded);
    if (amount > eligible) {
      throw new AppError('REFUND_EXCEEDS_ELIGIBLE_AMOUNT', `Cannot refund ${amount}; only ${eligible} is eligible for refund`, 422);
    }

    const payment = await db.Payment.findOne({ where: { orderId: order.id, workspaceId, status: 'captured' }, transaction });

    const refund = await db.Refund.create(
      {
        workspaceId,
        orderId: order.id,
        paymentId: payment ? payment.id : null,
        amount,
        reason,
        status: 'pending',
        processedByUserId: req.user.id,
      },
      { transaction }
    );

    if (payment) {
      const provider = getProvider(payment.providerCode);
      await provider.refund({ providerReference: payment.providerReference, amount });
    }
    await refund.update({ status: 'processed' }, { transaction });

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
  });
}

module.exports = { initializePayment, capturePayment, processRefund };
