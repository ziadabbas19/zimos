'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { sanitizeGatewayMessage } = require('../payments/gateways/gatewayErrors');
const { recordAudit } = require('../audit/auditService');
const charges = require('./subscriptionChargeService');
const fawaterakConfig = require('./fawaterak/config');
const { toMajor } = require('./fawaterak/amounts');
const { verifyWebhook } = require('./fawaterak/signature');
const gateways = require('./gateways/registry');
const paymentMethods = require('./paymentMethodService');
const wallet = require('./walletService');

/**
 * A merchant paying their subscription charge online, through a gateway of
 * Zimos's own (billing/gateways: Fawaterak today, each gateway an adapter).
 * Nothing here is shared with the stores' own gateways (modules/payments).
 *
 *   1. `startPayment` (the merchant's Pay button): the pending charge
 *      (createCharge, which reuses an open one), its price as payable now
 *      frozen on a new attempt, and a hosted checkout link from the
 *      adapter's createPayment. Fawaterak: EGP charges only, and
 *      ONLINE_BILLING_ENABLED gates it.
 *
 *   2. `confirmAttempt` is the only place a payment is believed: it asks the
 *      gateway's own API (the adapter's fetchPayment, Fawaterak's
 *      getTransactionData), never a webhook body (Fawaterak's signature
 *      doesn't cover the status or the amount). Paid means the gateway says
 *      paid, the intent and the carried reference name this attempt, and the
 *      total and currency are exactly the frozen price. Webhooks, the sweep
 *      and the merchant's status read all end here.
 *
 *   3. `settleConfirmed` locks the charge, then the attempt, and goes
 *      through settlePaid — the charge-paid path a payment recorded by hand
 *      also takes — at the frozen price. A charge already paid is never
 *      paid again: the attempt is marked paid_duplicate (money to refund by
 *      hand). A payment that doesn't match is marked mismatch and settles
 *      nothing.
 *
 * A failed, cancelled or expired attempt changes only the attempt: never the
 * charge (no markChargeFailed) and never the subscription. Pressing Pay
 * again makes a new attempt. The one exception, with PLAN_SWITCH_ENABLED
 * on: a plan switch's charge nothing else is paying is voided and its
 * switch cancelled (planSwitchService.paymentFailed), so the store stays on
 * its plan with nothing pending.
 *
 * A card top-up of the prepaid balance (`startTopup`, migration 221) is an
 * attempt with purpose 'topup' and no charge: the same webhooks, sweep and
 * confirmation, and `settleConfirmed` credits the balance through
 * walletService.creditGatewayTopup (topup:attempt:<id>) once instead of
 * settling a charge. Every paid top-up attempt credits what it was for;
 * none supersedes another.
 */

const PROVIDER = 'fawaterak';
const ONLINE_CURRENCY = 'EGP';
const { IN_PROGRESS, SETTLED } = db.BillingPaymentAttempt;
// A second press within this window gets the same checkout back.
const REPRESS_WINDOW_MS = 60 * 1000;
// Used when createTransaction gives no expires_in (its own default due date).
const FALLBACK_LINK_SECONDS = 2 * 24 * 60 * 60;
// The merchant's status read asks Fawaterak at most this often per attempt.
const STATUS_READ_EVERY_MS = 10 * 1000;

const now = () => new Date();

function currencyNotSupported(currency, adapter) {
  return new ConflictError(
    `Online payment is only available for plans priced in ${adapter.currencies.join(' or ')}. This plan is priced in ${currency}; pay it another way.`,
    'ONLINE_PAYMENT_CURRENCY_UNSUPPORTED'
  );
}

function unavailable() {
  return new AppError('ONLINE_BILLING_UNAVAILABLE', 'Online payment is not available right now.', 503);
}

/**
 * Where Fawaterak sends the merchant back: the dashboard, which then asks us.
 * It names the store, since the dashboard's current store is whichever was
 * picked last in that browser. `result` says which of Fawaterak's redirects
 * it was (success, fail, pending, back): the page words its message with it,
 * and nothing else ever reads it — the payment's state comes from us.
 */
function returnUrl(attempt, result) {
  const base = env.frontendUrl.replace(/\/+$/, '');
  if (attempt.purpose === 'topup') {
    return `${base}/subscription?tab=usage&topup=${attempt.id}&workspace=${attempt.workspaceId}&result=${result}`;
  }
  return `${base}/settings?payment=${attempt.id}&workspace=${attempt.workspaceId}&result=${result}`;
}

function returnUrls(attempt) {
  return {
    success: returnUrl(attempt, 'success'),
    fail: returnUrl(attempt, 'fail'),
    pending: returnUrl(attempt, 'pending'),
    back: returnUrl(attempt, 'back'),
  };
}

function reasonOf(err) {
  return sanitizeGatewayMessage(err && err.message ? err.message : String(err)).slice(0, 300) || 'unknown error';
}

// -------------------------------------------------------------- serialize

/** What the merchant sees of an attempt. The checkout link only while it can be used. */
function serializeForMerchant(attempt) {
  if (!attempt) return null;
  return {
    id: attempt.id,
    purpose: attempt.purpose || 'invoice',
    status: attempt.status,
    amount: Number(attempt.amount),
    currency: attempt.currency,
    checkoutUrl: IN_PROGRESS.includes(attempt.status) ? attempt.checkoutUrl : null,
    paymentMethod: attempt.paymentMethod,
    referenceNumber: attempt.referenceNumber,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
    paidAt: attempt.paidAt,
  };
}

// ------------------------------------------------------------ start a payment

/**
 * The gateway a Pay press goes through. Without `method`, Fawaterak, as
 * before payment methods existed (what an older dashboard sends); with one,
 * a gateway the merchant is offered: its payment_methods row enabled and its
 * adapter configured (paymentMethodService), or 404.
 */
async function startingGateway(method) {
  if (!method) return gateways.get(PROVIDER);
  const adapter = await paymentMethods.offeredGateway(method);
  if (!adapter) throw new AppError('PAYMENT_METHOD_NOT_AVAILABLE', 'This payment method is not available.', 404);
  return adapter;
}

/**
 * The merchant's Pay button. Resolves { payment, reused }: `reused` when the
 * same checkout is handed back for a second press within a minute. An older
 * checkout still in progress is superseded (its link may still be paid: that
 * payment still settles the charge, or is caught as a duplicate).
 */
async function startPayment(workspaceId, { lang, method } = {}, req) {
  const adapter = await startingGateway(method);
  adapter.assertCanStart();

  const subscription = await db.Subscription.findOne({ where: { workspaceId }, include: [{ model: db.Plan, as: 'plan' }] });
  if (!subscription) throw new NotFoundError('Subscription');
  if (subscription.plan && !adapter.currencies.includes(subscription.plan.currency)) {
    throw currencyNotSupported(subscription.plan.currency, adapter);
  }

  const { invoice } = await charges.createCharge(workspaceId, { req, byMerchant: true });
  if (!adapter.currencies.includes(invoice.currency)) throw currencyNotSupported(invoice.currency, adapter);

  const { attempt, reused } = await db.sequelize.transaction(async (transaction) => {
    const locked = await db.BillingInvoice.findByPk(invoice.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (locked.status !== 'pending') throw new ConflictError('This charge is already paid.', 'CHARGE_NOT_PENDING');

    const current = await db.BillingPaymentAttempt.findOne({
      where: { billingInvoiceId: locked.id, status: IN_PROGRESS },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (current && current.provider === adapter.code && now().getTime() - new Date(current.createdAt).getTime() < REPRESS_WINDOW_MS) {
      if (current.status === 'created') {
        throw new ConflictError('A payment is being started for this charge. Try again in a moment.', 'PAYMENT_STARTING');
      }
      return { attempt: current, reused: true };
    }
    if (current) await current.update({ status: 'superseded' }, { transaction });

    const payable = await charges.payableNow(locked, transaction);
    if (!(payable.amount > 0)) throw new ConflictError('Nothing is due on this charge.', 'NOTHING_TO_PAY');
    const created = await db.BillingPaymentAttempt.create(
      {
        billingInvoiceId: locked.id,
        workspaceId,
        subscriptionId: locked.subscriptionId,
        provider: adapter.code,
        status: 'created',
        grossAmount: payable.grossAmount,
        discountAmount: payable.discountAmount,
        amount: payable.amount,
        currency: locked.currency,
        referralCodeId: payable.referralCodeId,
        createdByUserId: req.user.id,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'billing_payment.start',
      entityType: 'BillingPaymentAttempt',
      entityId: created.id,
      after: { amount: payable.amount, currency: locked.currency, discountAmount: payable.discountAmount },
      metadata: { billingInvoiceId: locked.id, provider: adapter.code, superseded: current ? current.id : null },
      req,
      transaction,
    });
    return { attempt: created, reused: false };
  });
  if (reused) return { payment: serializeForMerchant(attempt), reused: true };
  // A pay-per-order store's move is paid for the plan it moves to.
  const plan = invoice.targetPlanId ? await db.Plan.findByPk(invoice.targetPlanId) : subscription.plan;
  const billingCycle = invoice.targetBillingCycle || subscription.billingCycle;
  return { payment: await openCheckout(adapter, attempt, { plan, billingCycle, lang }, req), reused: false };
}

/** The hosted checkout for a new attempt; an attempt with no checkout is marked error (502). */
async function openCheckout(adapter, attempt, { plan, billingCycle, lang }, req) {
  let link;
  try {
    link = await adapter.createPayment({
      attempt,
      plan,
      billingCycle,
      user: req.user,
      lang,
      returnUrls: returnUrls(attempt),
    });
  } catch (err) {
    await attempt.update({ status: 'error', failureReason: reasonOf(err) });
    logger.error(`billing payment attempt ${attempt.id}: no checkout from ${adapter.name}: ${reasonOf(err)}`);
    if (err && err.code === 'ONLINE_BILLING_UNAVAILABLE') throw err;
    throw new AppError(
      'ONLINE_PAYMENT_START_FAILED',
      'The payment page could not be opened. Try again in a few minutes, or pay another way.',
      502
    );
  }

  const expiresAt = new Date(Date.now() + (link.expiresInSeconds || FALLBACK_LINK_SECONDS) * 1000);
  await attempt.update({ providerIntentKey: link.providerRef, checkoutUrl: link.checkoutUrl, expiresAt });
  // Only a checkout still being made becomes open: one superseded meanwhile
  // keeps that status (its link can still settle the charge if paid).
  await db.BillingPaymentAttempt.update({ status: 'open' }, { where: { id: attempt.id, status: 'created' } });
  await attempt.reload();
  logger.info(
    attempt.purpose === 'topup'
      ? `billing payment attempt ${attempt.id}: checkout created for a top-up`
      : `billing payment attempt ${attempt.id}: checkout created for invoice ${attempt.billingInvoiceId}`
  );
  return serializeForMerchant(attempt);
}

// ------------------------------------------------------------- top-ups

/**
 * POST /workspaces/:id/billing/wallet/topups/online { amount, method, lang } —
 * a card top-up of the prepaid balance. WALLET_ENABLED and a store on the
 * pay-per-order plan; the amount within walletService's top-up limits, in
 * EGP; the gateway one the merchant is offered (as for Pay). A second press
 * for the same amount within a minute gets the same checkout back.
 */
async function startTopup(workspaceId, { amount, lang, method } = {}, req) {
  if (!wallet.enabled()) throw wallet.disabledError();
  if (!(await wallet.termsDue(workspaceId))) {
    throw new ConflictError('Topping up by card is for stores on the pay-per-order plan.', 'WALLET_NOT_ON_PLAN');
  }
  if (!Number.isSafeInteger(amount) || amount < wallet.MIN_TOPUP_AMOUNT || amount > wallet.MAX_TOPUP_AMOUNT) {
    throw new AppError(
      'TOPUP_AMOUNT_OUT_OF_RANGE',
      `A top-up is between ${wallet.MIN_TOPUP_AMOUNT} and ${wallet.MAX_TOPUP_AMOUNT} (minor units).`,
      422,
      { min: wallet.MIN_TOPUP_AMOUNT, max: wallet.MAX_TOPUP_AMOUNT, currency: wallet.WALLET_CURRENCY }
    );
  }
  const adapter = await startingGateway(method);
  adapter.assertCanStart();
  if (!adapter.currencies.includes(wallet.WALLET_CURRENCY)) throw currencyNotSupported(wallet.WALLET_CURRENCY, adapter);
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, attributes: ['id'] });
  if (!subscription) throw new NotFoundError('Subscription');

  const recent = await db.BillingPaymentAttempt.findOne({
    where: {
      workspaceId,
      purpose: 'topup',
      provider: adapter.code,
      amount,
      status: IN_PROGRESS,
      createdAt: { [db.Sequelize.Op.gt]: new Date(now().getTime() - REPRESS_WINDOW_MS) },
    },
    order: [['createdAt', 'DESC']],
  });
  if (recent) {
    if (recent.status === 'created') throw new ConflictError('A payment is being started. Try again in a moment.', 'PAYMENT_STARTING');
    return { payment: serializeForMerchant(recent), reused: true };
  }

  const attempt = await db.sequelize.transaction(async (transaction) => {
    const created = await db.BillingPaymentAttempt.create(
      {
        purpose: 'topup',
        billingInvoiceId: null,
        workspaceId,
        subscriptionId: subscription.id,
        provider: adapter.code,
        status: 'created',
        grossAmount: amount,
        discountAmount: 0,
        amount,
        currency: wallet.WALLET_CURRENCY,
        referralCodeId: null,
        createdByUserId: req.user.id,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'wallet.topup_start',
      entityType: 'BillingPaymentAttempt',
      entityId: created.id,
      after: { amount, currency: wallet.WALLET_CURRENCY },
      metadata: { purpose: 'topup', provider: adapter.code },
      req,
      transaction,
    });
    return created;
  });
  return { payment: await openCheckout(adapter, attempt, { plan: null, billingCycle: null, lang }, req), reused: false };
}

/** The store's latest card top-ups, newest first, for the Usage tab. */
async function listTopups(workspaceId, { limit = 5 } = {}) {
  const rows = await db.BillingPaymentAttempt.findAll({
    where: { workspaceId, purpose: 'topup' },
    order: [['createdAt', 'DESC']],
    limit,
  });
  return rows.map(serializeForMerchant);
}

/**
 * A confirmed top-up: the attempt locked, then the wallet (its last lock).
 * Resolves { outcome, attempt }: paid | mismatch | already_settled. The
 * credit is the amount the attempt was for, which the gateway's own answer
 * must match exactly.
 */
async function settleTopup(attemptId, verification, { source }, transaction) {
  const attempt = await db.BillingPaymentAttempt.findByPk(attemptId, { transaction, lock: transaction.LOCK.UPDATE });
  if (SETTLED.includes(attempt.status)) return { outcome: 'already_settled', attempt };
  const { fields, gatewayPaidAt } = verification;
  const problems = [...verification.problems];
  const audit = (action, extra = {}) =>
    recordAudit({
      workspaceId: attempt.workspaceId,
      action,
      entityType: 'BillingPaymentAttempt',
      entityId: attempt.id,
      after: { status: attempt.status, verifiedAmount: fields.verifiedAmount, verifiedCurrency: fields.verifiedCurrency },
      metadata: { purpose: 'topup', provider: attempt.provider, providerTransactionId: fields.providerTransactionId, gatewayPaidAt, source, ...extra },
      transaction,
    });
  if (problems.length > 0) {
    await attempt.update({ status: 'mismatch', ...fields, failureReason: problems.join('; ').slice(0, 300) }, { transaction });
    await audit('billing_payment.mismatch', { problems });
    logger.error(`billing payment attempt ${attempt.id}: ${attempt.provider} reports a top-up paid, but ${problems.join('; ')}. Nothing was credited.`);
    return { outcome: 'mismatch', attempt };
  }
  const entry = await wallet.creditGatewayTopup(attempt, Number(attempt.amount), transaction);
  await attempt.update({ status: 'paid', ...fields }, { transaction });
  await audit('wallet.gateway_topup', { ledgerEntryId: entry ? entry.id : null });
  return { outcome: 'paid', attempt };
}

// ------------------------------------------------------- confirm and settle

/**
 * What the gateway says about a paid payment (the adapter's fetchPayment),
 * checked against the attempt: the same rules for every gateway.
 */
function verifyPaid(attempt, payment) {
  const problems = [];
  if (payment.providerRef !== undefined && payment.providerRef !== attempt.providerIntentKey) problems.push('the intent key differs');
  if (payment.attemptRef !== attempt.id) problems.push('pay_load does not name this attempt');
  if (payment.currency !== attempt.currency) problems.push(`currency ${payment.currency || '(none)'} instead of ${attempt.currency}`);
  if (payment.amount !== Number(attempt.amount)) problems.push(`total ${payment.amountText} instead of ${toMajor(attempt.amount)}`);
  return {
    problems,
    fields: {
      verifiedAmount: Number.isNaN(payment.amount) ? null : payment.amount,
      verifiedCurrency: /^[A-Z]{3}$/.test(payment.currency) ? payment.currency : null,
      providerTransactionId: payment.transactionId,
      paymentMethod: payment.paymentMethod || attempt.paymentMethod,
      // The gateway's own paid-at may not say its time zone, so the charge
      // is dated when we confirmed it; the gateway's text is audited.
      paidAt: now(),
    },
    gatewayPaidAt: payment.gatewayPaidAt,
  };
}

/**
 * Settles the charge from a confirmed payment. Locks the charge, then the
 * attempt (the order every path uses). Resolves { outcome, attempt }:
 * paid | duplicate | mismatch | already_settled.
 */
async function settleConfirmed(attemptId, verification, { source }) {
  return db.sequelize.transaction(async (transaction) => {
    const { billingInvoiceId, purpose } = await db.BillingPaymentAttempt.findByPk(attemptId, {
      attributes: ['billingInvoiceId', 'purpose'],
      transaction,
    });
    if (purpose === 'topup') return settleTopup(attemptId, verification, { source }, transaction);
    const invoice = await db.BillingInvoice.findByPk(billingInvoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    const attempt = await db.BillingPaymentAttempt.findByPk(attemptId, { transaction, lock: transaction.LOCK.UPDATE });
    if (SETTLED.includes(attempt.status)) return { outcome: 'already_settled', attempt };

    const { fields, gatewayPaidAt } = verification;
    const problems = [...verification.problems];
    if (Number(attempt.grossAmount) !== Number(invoice.grossAmount)) problems.push('the charge was re-priced after this checkout');
    const audit = (action, extra = {}) =>
      recordAudit({
        workspaceId: attempt.workspaceId,
        action,
        entityType: 'BillingPaymentAttempt',
        entityId: attempt.id,
        after: { status: attempt.status, verifiedAmount: fields.verifiedAmount, verifiedCurrency: fields.verifiedCurrency },
        metadata: {
          billingInvoiceId: invoice.id,
          provider: attempt.provider,
          providerTransactionId: fields.providerTransactionId,
          gatewayPaidAt,
          source,
          ...extra,
        },
        transaction,
      });

    if (problems.length > 0) {
      await attempt.update({ status: 'mismatch', ...fields, failureReason: problems.join('; ').slice(0, 300) }, { transaction });
      await audit('billing_payment.mismatch', { problems });
      logger.error(`billing payment attempt ${attempt.id}: ${attempt.provider} reports it paid, but ${problems.join('; ')}. The charge was not settled.`);
      return { outcome: 'mismatch', attempt };
    }

    if (invoice.status === 'paid') {
      await attempt.update({ status: 'paid_duplicate', ...fields }, { transaction });
      await audit('billing_payment.duplicate');
      logger.error(
        `billing payment attempt ${attempt.id}: paid ${fields.verifiedAmount} ${fields.verifiedCurrency} for invoice ${invoice.id}, ` +
          'which was already paid. Nothing was settled again; refund it by hand.'
      );
      return { outcome: 'duplicate', attempt };
    }

    const { commission, codeLapsed } = await charges.settlePaid(
      invoice,
      {
        paidAt: fields.paidAt,
        amountPaid: fields.verifiedAmount,
        externalReference: `${attempt.provider}:${fields.providerTransactionId || attempt.providerIntentKey}`,
        source: 'gateway',
        frozen: { discountAmount: attempt.discountAmount, amount: attempt.amount, referralCodeId: attempt.referralCodeId },
      },
      transaction
    );
    await attempt.update({ status: 'paid', ...fields }, { transaction });
    // Another checkout still open for this charge can no longer pay it.
    await db.BillingPaymentAttempt.update(
      { status: 'superseded' },
      { where: { billingInvoiceId: invoice.id, id: { [db.Sequelize.Op.ne]: attempt.id }, status: IN_PROGRESS }, transaction }
    );
    await audit('billing_invoice.gateway_payment', { commissionId: commission ? commission.id : null, referralCodeLapsed: codeLapsed });
    return { outcome: 'paid', attempt };
  });
}

/** Records what an unpaid payment shows (the method, a reference) without settling anything. */
async function noteUnpaid(attempt, payment) {
  const reference = payment.reference;
  const changes = {};
  if (payment.paymentMethod) changes.paymentMethod = payment.paymentMethod;
  if (reference) changes.referenceNumber = reference;
  if (Object.keys(changes).length > 0) {
    await db.BillingPaymentAttempt.update(changes, { where: { id: attempt.id, status: { [db.Sequelize.Op.notIn]: SETTLED } } });
  }
  // A reference means an async method was chosen: awaiting the customer.
  if (reference) await db.BillingPaymentAttempt.update({ status: 'pending' }, { where: { id: attempt.id, status: 'open' } });
  return { outcome: 'not_paid' };
}

/**
 * Asks the attempt's gateway whether it is paid and acts on the answer.
 * Resolves { outcome }: paid | duplicate | mismatch | already_settled |
 * not_paid | unknown_intent. Throws when the gateway gave no answer (the
 * caller retries later). `retry` retries the read itself — not on a webhook,
 * which should be answered promptly.
 */
async function confirmAttempt(attempt, { retry = false, source }) {
  const adapter = gateways.get(attempt.provider);
  if (!adapter || !adapter.canConfirm()) throw unavailable();
  if (!attempt.providerIntentKey) return { outcome: 'unknown_intent' };
  await db.BillingPaymentAttempt.update(
    { lastCheckedAt: now(), checkCount: db.sequelize.literal('check_count + 1') },
    { where: { id: attempt.id } }
  );
  const payment = await adapter.fetchPayment(attempt, { retry });
  if (!payment.found) return { outcome: 'unknown_intent' };
  if (!payment.paid) return noteUnpaid(attempt, payment);
  return settleConfirmed(attempt.id, verifyPaid(attempt, payment), { source });
}

// --------------------------------------------------------------- webhooks
//
// Fawaterak POSTs to /billing/fawaterak/:token/:route. The token (ours,
// FAWATERAK_WEBHOOK_TOKEN) and the signature (FAWATERAK_HASH_KEY) are both
// checked before anything is written; a verified webhook is kept in the inbox
// once per event key, then acted on — and acting on it always means asking
// getTransactionData (confirmAttempt). Its unsigned fields only ever pick
// which attempt to ask about, or are kept for the record.

// Our route names. Paid and failed end in `_json` so Fawaterak sends JSON.
const WEBHOOK_ROUTES = { paid_json: 'paid', failed_json: 'failed', cancel: 'cancel', refund: 'refund' };

// What is kept of each webhook: never a signature, the legacy api_key or the
// customer's details.
const STORED_FIELDS = {
  paid: [
    'transaction_key',
    'transaction_id',
    'payment_method',
    'status',
    'pay_load',
    'paidAmount',
    'paidCurrency',
    'paidAt',
    'referenceNumber',
    'fees',
    'cardDiscountAmount',
  ],
  failed: ['transaction_key', 'transaction_id', 'payment_method', 'pay_load', 'amount', 'paidCurrency', 'errorMessage'],
  cancel: ['referenceId', 'status', 'paymentMethod', 'pay_load', 'transactionId', 'transactionKey'],
  refund: ['transactionId', 'amount', 'currency', 'status', 'reason', 'approvedAt'],
};

const MAX_EVENT_TRIES = 10;

function storablePayload(kind, body) {
  const out = {};
  for (const field of STORED_FIELDS[kind]) {
    const value = body[field];
    if (typeof value === 'string') out[field] = value.slice(0, 500);
    else if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  return out;
}

/**
 * The event's identity (from signed fields, plus a status limited to the
 * documented values) and what identifies its attempt. Null for a body not
 * acted on.
 */
function identify(kind, body) {
  switch (kind) {
    case 'paid':
      if (!['paid', 'pending'].includes(body.status)) return null;
      return { eventKey: `paid:${body.transaction_key}:${body.status}`, intentKey: String(body.transaction_key) };
    case 'failed':
      return { eventKey: `failed:${body.transaction_key}:${body.transaction_id}`, intentKey: String(body.transaction_key) };
    case 'cancel':
      if (!['EXPIRED', 'CANCELED'].includes(body.status)) return null;
      // This signature covers referenceId and paymentMethod only: the
      // transactionKey just says which attempt to ask Fawaterak about.
      return {
        eventKey: `cancel:${body.referenceId}:${body.status}`,
        intentKey: typeof body.transactionKey === 'string' ? body.transactionKey : null,
      };
    case 'refund':
      return { eventKey: `refund:${body.transactionId}:${body.amount}:${body.currency}`, transactionId: Number(body.transactionId) };
    default:
      return null;
  }
}

function findAttempt(identity) {
  if (identity.intentKey) {
    return db.BillingPaymentAttempt.findOne({ where: { provider: PROVIDER, providerIntentKey: identity.intentKey.slice(0, 64) } });
  }
  if (Number.isSafeInteger(identity.transactionId) && identity.transactionId > 0) {
    return db.BillingPaymentAttempt.findOne({ where: { provider: PROVIDER, providerTransactionId: identity.transactionId } });
  }
  return null;
}

/** Writes the event once per (provider, event key); a redelivery gets the existing row. */
async function insertEvent(kind, eventKey, attempt, payload) {
  const key = eventKey.slice(0, 200);
  const [row] = await db.sequelize.query(
    `INSERT INTO billing_gateway_events (id, provider, kind, event_key, attempt_id, payload, attempts, created_at, updated_at)
     VALUES ($id, $provider, $kind, $eventKey, $attemptId, $payload::jsonb, 0, now(), now())
     ON CONFLICT (provider, event_key) DO NOTHING
     RETURNING id`,
    {
      bind: {
        id: crypto.randomUUID(),
        provider: PROVIDER,
        kind,
        eventKey: key,
        attemptId: attempt ? attempt.id : null,
        payload: JSON.stringify(payload),
      },
      type: db.Sequelize.QueryTypes.SELECT,
    }
  );
  if (row) return { event: await db.BillingGatewayEvent.findByPk(row.id), created: true };
  return { event: await db.BillingGatewayEvent.findOne({ where: { provider: PROVIDER, eventKey: key } }), created: false };
}

/** A failed or expired attempt: only one still in progress moves, and never the charge. */
async function markNotPaid(attempt, status, reason) {
  const [moved] = await db.BillingPaymentAttempt.update(
    { status, failureReason: reason ? sanitizeGatewayMessage(reason).slice(0, 300) : null },
    { where: { id: attempt.id, status: ['open', 'pending'] } }
  );
  return moved > 0;
}

/**
 * After a checkout for a charge did not go through: a plan switch's charge
 * nothing else is paying is voided (planSwitchService.paymentFailed).
 * Logged, never thrown: the attempt is marked either way.
 */
async function afterNotPaid(attempt, source) {
  if (!attempt.billingInvoiceId) return;
  try {
    // eslint-disable-next-line global-require
    await require('./planSwitchService').paymentFailed(attempt.billingInvoiceId, { source });
  } catch (err) {
    logger.warn(`billing payment attempt ${attempt.id}: the plan switch's charge could not be voided: ${reasonOf(err)}`);
  }
}

/** A refund Fawaterak approved: recorded for a platform admin, nothing changed (refunds are handled by hand). */
async function recordRefund(attempt, payload) {
  await recordAudit({
    workspaceId: attempt.workspaceId,
    action: 'billing_payment.refund_reported',
    entityType: 'BillingPaymentAttempt',
    entityId: attempt.id,
    metadata: {
      billingInvoiceId: attempt.billingInvoiceId,
      provider: PROVIDER,
      amount: payload.amount,
      currency: payload.currency,
      approvedAt: payload.approvedAt || null,
      reason: payload.reason ? String(payload.reason).slice(0, 300) : null,
    },
  });
  logger.warn(
    `billing payment attempt ${attempt.id}: Fawaterak reports a refund of ${payload.amount} ${payload.currency} ` +
      `(invoice ${attempt.billingInvoiceId}). Nothing was changed; handle it by hand.`
  );
  return 'refund_recorded';
}

async function actOn(event, attempt) {
  const { kind, payload } = event;
  if (kind === 'refund') return recordRefund(attempt, payload);
  const { outcome } = await confirmAttempt(attempt, { source: `webhook:${kind}` });
  if (outcome !== 'not_paid') return outcome;
  if (kind === 'paid') return payload.status === 'paid' ? 'not_confirmed' : 'pending';
  if (kind === 'failed') {
    if (!(await markNotPaid(attempt, 'failed', payload.errorMessage))) return 'not_paid';
    await afterNotPaid(attempt, 'webhook:failed');
    return 'failed';
  }
  if (!(await markNotPaid(attempt, 'expired', `${payload.paymentMethod || 'reference'} ${String(payload.status).toLowerCase()}`))) return 'not_paid';
  await afterNotPaid(attempt, 'webhook:cancel');
  return 'expired';
}

/**
 * Processes one stored event. A failure (Fawaterak unreachable) leaves it
 * unprocessed with the error, for the sweep; the webhook is still answered
 * 200, since the event is safely stored.
 */
async function processEvent(event) {
  const [claimed] = await db.BillingGatewayEvent.update(
    { attempts: db.sequelize.literal('attempts + 1') },
    { where: { id: event.id, processedAt: null } }
  );
  if (!claimed) return { outcome: 'duplicate' };
  try {
    const attempt = event.attemptId ? await db.BillingPaymentAttempt.findByPk(event.attemptId) : null;
    const outcome = attempt ? await actOn(event, attempt) : 'not_ours';
    // Two deliveries racing both get here; the first to finish is recorded.
    await db.BillingGatewayEvent.update({ processedAt: now(), outcome, error: null }, { where: { id: event.id, processedAt: null } });
    return { outcome };
  } catch (err) {
    await db.BillingGatewayEvent.update({ error: reasonOf(err).slice(0, 500) }, { where: { id: event.id } });
    logger.error(`billing gateway event ${event.id} (${event.kind}) could not be processed yet: ${reasonOf(err)}`);
    return { outcome: 'deferred' };
  }
}

function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * One Fawaterak webhook. Resolves { status, outcome }: 404 for an unknown
 * route or token (or nothing configured), 401 for a signature that doesn't
 * verify — neither writes anything — otherwise 200.
 */
async function receiveWebhook(route, token, body) {
  const kind = Object.prototype.hasOwnProperty.call(WEBHOOK_ROUTES, route) ? WEBHOOK_ROUTES[route] : null;
  const config = kind ? fawaterakConfig.readyConfig() : null;
  if (!kind || !config || !tokenMatches(token, config.webhookToken)) return { status: 404 };
  if (!body || typeof body !== 'object' || !verifyWebhook(kind, body, config.hashKey)) {
    logger.warn(`Fawaterak ${kind} webhook refused: its signature does not verify`);
    return { status: 401 };
  }

  const identity = identify(kind, body);
  if (!identity) return { status: 200, outcome: 'ignored' };
  const attempt = await findAttempt(identity);
  const { event, created } = await insertEvent(kind, identity.eventKey, attempt, storablePayload(kind, body));
  if (!created && (event.processedAt || event.attempts >= MAX_EVENT_TRIES)) return { status: 200, outcome: 'duplicate' };
  const { outcome } = await processEvent(event);
  logger.info(`Fawaterak ${kind} webhook${attempt ? ` for billing payment attempt ${attempt.id}` : ''}: ${outcome}`);
  return { status: 200, outcome };
}

// --------------------------------------------------------------- merchant

/**
 * One attempt of the merchant's, for the page Fawaterak sends them back to.
 * While it is in progress, Fawaterak is asked first (at most every ten
 * seconds per attempt) — the redirect itself proves nothing.
 */
async function getPayment(workspaceId, attemptId) {
  const attempt = await db.BillingPaymentAttempt.findOne({ where: { id: attemptId, workspaceId } });
  if (!attempt) throw new NotFoundError('Payment');
  const askable = ['open', 'pending', 'superseded'].includes(attempt.status) && attempt.providerIntentKey;
  const recently = attempt.lastCheckedAt && now().getTime() - new Date(attempt.lastCheckedAt).getTime() < STATUS_READ_EVERY_MS;
  const adapter = gateways.get(attempt.provider);
  if (askable && !recently && adapter && adapter.canConfirm()) {
    try {
      await confirmAttempt(attempt, { retry: true, source: 'status_read' });
    } catch (err) {
      logger.warn(`billing payment attempt ${attempt.id}: status read could not reach ${adapter.name}: ${reasonOf(err)}`);
    }
    await attempt.reload();
  }
  // A top-up has no charge: its own status says whether the balance was credited.
  if (attempt.purpose === 'topup') return { payment: serializeForMerchant(attempt), chargeStatus: null };
  const invoice = await db.BillingInvoice.findByPk(attempt.billingInvoiceId, { attributes: ['id', 'status'] });
  return { payment: serializeForMerchant(attempt), chargeStatus: invoice.status };
}

/** For the merchant's billing summary: whether they can pay online, and their latest attempt. */
async function onlinePaymentSummary(workspaceId, plan) {
  const latest = await db.BillingPaymentAttempt.findOne({ where: { workspaceId, purpose: 'invoice' }, order: [['createdAt', 'DESC']] });
  return {
    enabled: Boolean(plan) && plan.currency === ONLINE_CURRENCY && fawaterakConfig.onlinePaymentEnabled(),
    currency: ONLINE_CURRENCY,
    latest: serializeForMerchant(latest),
  };
}

// ------------------------------------------------------------------ sweep
//
// For when a webhook never came, or came while Fawaterak couldn't be asked
// (scripts/sweep-billing-payments.js, a cron service):
//
//   1. events     verified webhooks whose processing failed are processed again
//   2. stuck      an attempt left 'created' (the process died while asking for
//                 a checkout) becomes 'error': no one ever got its link
//   3. ask        every attempt that could still be paid — in progress,
//                 superseded, failed or expired, with a checkout link that
//                 hasn't been expired for more than a day — is asked about,
//                 often while young and less often as it ages; an unpaid one
//                 past its link's expiry becomes 'expired'
//
// All of it goes through confirmAttempt / settleConfirmed, so a sweep racing
// a webhook settles once.

const EVENT_RETRY_AFTER_MS = 60 * 1000;
const CREATED_STUCK_MS = 5 * 60 * 1000;
// A younger attempt is left to its webhook.
const LEAVE_TO_WEBHOOK_MS = 3 * 60 * 1000;
const ASK_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;
const ASKED = ['open', 'pending', 'superseded', 'failed', 'expired'];

/** How long to wait between two questions about an attempt this old. */
function askEvery(ageMs) {
  if (ageMs < 60 * 60 * 1000) return 5 * 60 * 1000;
  if (ageMs < 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  return 12 * 60 * 60 * 1000;
}

async function sweep({ limit = 50, at = now() } = {}) {
  const providers = gateways
    .all()
    .filter((adapter) => adapter.canConfirm())
    .map((adapter) => adapter.code);
  if (providers.length === 0) return { skipped: 'not_configured' };
  const { Op } = db.Sequelize;
  const result = { events: 0, stuck: 0, asked: 0, settled: 0, expired: 0, errors: 0 };

  const events = await db.BillingGatewayEvent.findAll({
    where: {
      processedAt: null,
      attempts: { [Op.lt]: MAX_EVENT_TRIES },
      createdAt: { [Op.lt]: new Date(at.getTime() - EVENT_RETRY_AFTER_MS) },
    },
    order: [['createdAt', 'ASC']],
    limit,
  });
  for (const event of events) {
    const { outcome } = await processEvent(event);
    result.events += 1;
    if (outcome === 'deferred') result.errors += 1;
  }

  [result.stuck] = await db.BillingPaymentAttempt.update(
    { status: 'error', failureReason: 'The checkout was never received from Fawaterak.' },
    { where: { status: 'created', createdAt: { [Op.lt]: new Date(at.getTime() - CREATED_STUCK_MS) } } }
  );

  const candidates = await db.BillingPaymentAttempt.findAll({
    where: {
      status: ASKED,
      provider: providers,
      providerIntentKey: { [Op.ne]: null },
      createdAt: { [Op.lt]: new Date(at.getTime() - LEAVE_TO_WEBHOOK_MS) },
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date(at.getTime() - ASK_AFTER_EXPIRY_MS) } }],
    },
    order: db.sequelize.literal('last_checked_at ASC NULLS FIRST'),
    limit: limit * 5,
  });
  const due = candidates
    .filter((a) => {
      if (!a.lastCheckedAt) return true;
      const age = at.getTime() - new Date(a.createdAt).getTime();
      return at.getTime() - new Date(a.lastCheckedAt).getTime() >= askEvery(age);
    })
    .slice(0, limit);

  for (const attempt of due) {
    try {
      const { outcome } = await confirmAttempt(attempt, { retry: true, source: 'sweep' });
      result.asked += 1;
      if (outcome === 'paid') result.settled += 1;
      if (outcome === 'not_paid' && attempt.expiresAt && new Date(attempt.expiresAt) < at) {
        if (await markNotPaid(attempt, 'expired', 'The checkout link expired unpaid.')) {
          result.expired += 1;
          await afterNotPaid(attempt, 'sweep');
        }
      }
    } catch (err) {
      result.errors += 1;
      logger.warn(`billing payment attempt ${attempt.id}: the sweep could not ask ${attempt.provider}: ${reasonOf(err)}`);
    }
  }
  return result;
}

module.exports = {
  startTopup,
  listTopups,
  PROVIDER,
  ONLINE_CURRENCY,
  IN_PROGRESS,
  SETTLED,
  startPayment,
  confirmAttempt,
  receiveWebhook,
  processEvent,
  sweep,
  getPayment,
  onlinePaymentSummary,
  serializeForMerchant,
};
