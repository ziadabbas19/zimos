'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const inventoryService = require('../inventory/inventoryService');
const { completeOrderInTransaction, afterOrderCompleted } = require('../orders/orderCompletion');
const { setFinancialState } = require('../orders/orderStateService');
const fraudRules = require('../fraud/fraudRules');
const gateways = require('./gateways');
const gatewayRuntime = require('./gatewayRuntime');
const methodsService = require('./paymentMethodsService');

/**
 * Online (gateway) payments for storefront orders.
 *
 * Lifecycle of an online order:
 *
 *   checkout      The order is created unpaid (financial_state 'pending',
 *                 stage awaiting_payment), its stock reserved, with
 *                 payment_expires_at = now + PAYMENT_ATTEMPT_TTL_MINUTES. No
 *                 confirmation task: a prepaid order is not called. It is not a
 *                 sale yet — no invoice, no discount redemption, no
 *                 customer.totalOrders, the cart and the autosaved checkout
 *                 stay unconverted (orders/orderCompletion.js). One payment
 *                 ATTEMPT (a `payments` row) is created and the shopper is
 *                 sent to the gateway.
 *   paid          The gateway's signed callback, the shopper's signed redirect,
 *                 or our own inquiry says a transaction on one of the order's
 *                 attempts succeeded (recordPaymentTransaction). The order
 *                 becomes a sale: amountPaid, financial_state 'paid', and the
 *                 order-completed step.
 *   retry         The shopper starts another attempt (another method, or the
 *                 same one again). Earlier open attempts are 'cancelled' —
 *                 but a payment that still lands on one is taken, never lost.
 *   switch to COD The order becomes a cash-on-delivery order: confirmation
 *                 task, order-completed step, no expiry.
 *   expired       Nobody paid by payment_expires_at. The gateway is asked
 *                 first; only then is the stock released and the order
 *                 cancelled ('payment_expired'). Lazy (on the shopper's status
 *                 check and before a checkout that needs the same stock) and by
 *                 the sweep (scripts/sweep-payments.js).
 *
 * The user's standing rules this implements:
 *   - Paid after expiry: stock is reserved again and the order reopened; when
 *     that is not possible the order stays cancelled, is recorded as paid and
 *     flagged paid_after_expiry for the merchant to refund.
 *   - Paid twice: both payments are recorded, the order is flagged
 *     duplicate_payment. Nothing is refunded automatically.
 *   - Paid in test mode: flagged test_payment; such an order cannot be shipped.
 */

const PAID_STATES = ['paid', 'partially_paid', 'refunded', 'partially_refunded'];
const OPEN_ATTEMPT = 'initialized';
const EXPIRED_REASON = 'payment_expired';
// How often a shopper's status check may ask the gateway about one attempt.
const INQUIRY_THROTTLE_MS = 5000;

const FLAGS = Object.freeze({
  TEST_PAYMENT: 'test_payment',
  DUPLICATE_PAYMENT: 'duplicate_payment',
  PAID_AFTER_EXPIRY: 'paid_after_expiry',
  PAID_AFTER_CANCEL: 'paid_after_cancel',
  PAID_AFTER_COD_SWITCH: 'paid_after_cod_switch',
  AMOUNT_MISMATCH: 'payment_amount_mismatch',
});

// ------------------------------------------------------------------ helpers

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function newPaymentToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function tokenMatches(order, token) {
  if (!order.paymentTokenHash || typeof token !== 'string' || !token) return false;
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(order.paymentTokenHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertOnlineEnabled() {
  if (!env.payments.onlineEnabled) {
    throw new AppError('PAYMENTS_ONLINE_DISABLED', 'Online payments are not available', 404);
  }
}

function withFlag(flags, flag) {
  return flags.includes(flag) ? flags : [...flags, flag];
}

function isPaid(order) {
  return PAID_STATES.includes(order.financialState);
}

/**
 * Where a gateway may send the shopper back to. Outside production anything
 * http(s). In production: https, and the platform's own domain or a
 * subdomain of it, one of this store's verified custom domains, or a host in
 * PAYMENT_RETURN_HOSTS. Anything else would let a crafted checkout use the
 * store's gateway page as a redirect to an arbitrary site.
 */
async function assertReturnUrl(workspaceId, returnUrl) {
  const invalid = (message) =>
    new ValidationError([{ field: 'returnUrl', message }], 'Invalid body');
  if (typeof returnUrl !== 'string' || !returnUrl) throw invalid('"returnUrl" is required for an online payment');
  let url;
  try {
    url = new URL(returnUrl);
  } catch (err) {
    throw invalid('"returnUrl" must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('"returnUrl" must be http(s)');
  if (!env.isProduction) return url.toString();
  if (url.protocol !== 'https:') throw invalid('"returnUrl" must be https');

  const host = url.hostname.toLowerCase();
  const root = env.platformRootDomain.toLowerCase();
  if (host === root || host.endsWith(`.${root}`)) return url.toString();
  if (env.payments.returnHosts.includes(host)) return url.toString();
  const domain = await db.Domain.findOne({
    where: { workspaceId, hostname: host, status: { [Op.in]: ['verified', 'active'] } },
    attributes: ['id'],
  });
  if (domain) return url.toString();
  throw invalid('"returnUrl" must point at this store');
}

// ------------------------------------------------------------- checkout path

/**
 * Everything the storefront checkout needs to know before creating an online
 * order: the method is offered, the gateway is usable. Throws the storefront's
 * 422 / 503 otherwise, before any stock is touched.
 */
async function prepareOnlineCheckout(workspace, body, req) {
  assertOnlineEnabled();
  require('./gatewayAccountService').assertConfigured();
  const preview = methodsService.isPreviewRequest(req, workspace.id);
  const method = await methodsService.resolveStorefrontMethod(workspace, body, { preview });
  const returnUrl = await assertReturnUrl(workspace.id, body.returnUrl);
  const { token, hash } = newPaymentToken();
  const expiresAt = new Date(Date.now() + env.payments.attemptTtlMinutes * 60 * 1000);
  return { method, returnUrl, token, tokenHash: hash, expiresAt };
}

/**
 * Starts one attempt on an unpaid online order: the row first (committed),
 * then the gateway. A gateway that refuses or does not answer leaves the
 * attempt 'failed' — the shopper can retry or switch to cash on delivery.
 */
async function startAttempt(order, { provider, method, returnUrl: template }) {
  const ctx = await gatewayRuntime.contextFor(order.workspaceId, provider);
  // The storefront builds its return URL before the order exists, with an
  // {orderId} placeholder (URL-encoded once it went through new URL()).
  const returnUrl = String(template).replace(/\{orderId\}|%7BorderId%7D/gi, order.id);
  const expiresAt = order.paymentExpiresAt;

  const attempt = await db.Payment.create({
    workspaceId: order.workspaceId,
    orderId: order.id,
    providerCode: provider,
    method,
    mode: ctx.mode,
    status: OPEN_ATTEMPT,
    amount: order.totalAmount,
    currency: order.currency,
    returnUrl,
    expiresAt,
  });

  try {
    if (!ctx.adapter.currencies.includes(order.currency)) {
      throw new AppError('PAYMENT_CURRENCY_UNSUPPORTED', `${ctx.adapter.name} cannot take payments in ${order.currency}`, 422);
    }
    const workspace = await db.Workspace.findByPk(order.workspaceId, { attributes: ['id', 'name'] });
    const result = await ctx.adapter.createPayment(ctx.credentials, {
      attempt,
      order,
      method,
      settings: ctx.settings,
      returnUrl,
      webhookUrl: ctx.account.webhookUrl,
      expiresInSeconds: Math.max(60, (new Date(expiresAt).getTime() - Date.now()) / 1000),
      storeName: workspace ? workspace.name : null,
    });
    await attempt.update({
      providerOrderId: result.providerOrderId,
      providerReference: result.providerReference,
      redirectUrl: result.redirectUrl,
    });
  } catch (err) {
    logger.warn('Could not start a gateway payment', {
      workspaceId: order.workspaceId,
      orderId: order.id,
      attemptId: attempt.id,
      provider,
      code: err.code,
      reason: err.message,
    });
    await attempt.update({ status: 'failed', failureReason: String(err.message || 'The payment could not be started').slice(0, 300) });
  }
  return attempt;
}

// ------------------------------------------------------ recording a payment

/**
 * Stock for a reopened order, all or nothing (a savepoint inside the caller's
 * transaction). Mirrors orderService.cancelOrder, which releases exactly
 * these quantities.
 */
async function reReserveStock(order, transaction) {
  const items = await db.OrderItem.findAll({ where: { orderId: order.id }, transaction });
  try {
    await db.sequelize.transaction({ transaction }, async (savepoint) => {
      for (const item of items) {
        if (!item.variantId) continue;
        await inventoryService.reserve(
          {
            workspaceId: order.workspaceId,
            variantId: item.variantId,
            quantity: item.quantity,
            referenceType: 'order_reopened',
            referenceId: order.id,
            actorUserId: null,
          },
          savepoint
        );
      }
    });
    return true;
  } catch (err) {
    // Not enough stock left (or a variant gone): the order cannot come back.
    if (err instanceof AppError) return false;
    throw err;
  }
}

async function releaseStock(order, transaction, referenceType) {
  const items = await db.OrderItem.findAll({ where: { orderId: order.id }, transaction });
  for (const item of items) {
    if (!item.variantId) continue;
    await inventoryService.release(
      {
        workspaceId: order.workspaceId,
        variantId: item.variantId,
        quantity: item.quantity,
        referenceType,
        referenceId: order.id,
        actorUserId: null,
      },
      transaction
    );
  }
}

/**
 * A payment transaction reported by the gateway (webhook, redirect or
 * inquiry). Idempotent: an attempt already captured is left alone.
 *
 * @param {object} account  { workspaceId, providerCode }
 * @param {object} tx       normalized transaction (see gateways/index.js)
 * @returns {{ outcome, paymentId?, orderId? }}
 */
async function recordPaymentTransaction(account, tx) {
  if (!tx.providerOrderId) return { outcome: 'unmatched' };
  const attempt = await db.Payment.findOne({
    where: { workspaceId: account.workspaceId, providerCode: account.providerCode, providerOrderId: tx.providerOrderId },
  });
  if (!attempt) return { outcome: 'unmatched' };
  const ids = { paymentId: attempt.id, orderId: attempt.orderId };

  if (tx.status === 'pending') return { outcome: 'pending', ...ids };

  if (tx.status === 'failed') {
    const [n] = await db.Payment.update(
      {
        status: 'failed',
        failureReason: tx.failureReason || 'The payment was declined',
        providerTransactionId: tx.transactionId,
        maskedDisplay: tx.maskedDisplay,
      },
      { where: { id: attempt.id, status: OPEN_ATTEMPT } }
    );
    return { outcome: n ? 'failed' : 'ignored_failed', ...ids };
  }

  const completed = { value: null };
  const outcome = await db.sequelize.transaction(async (transaction) => {
    const payment = await db.Payment.findOne({ where: { id: attempt.id }, transaction, lock: transaction.LOCK.UPDATE });
    if (['captured', 'partially_refunded', 'refunded'].includes(payment.status)) return 'already_recorded';

    const order = await db.Order.findOne({ where: { id: payment.orderId }, transaction, lock: transaction.LOCK.UPDATE });
    let flags = [...(order.riskFlags || [])];
    const before = {
      financialState: order.financialState,
      amountPaid: Number(order.amountPaid),
      cancelledAt: order.cancelledAt,
      riskFlags: order.riskFlags,
    };

    const sameCurrency = !tx.currency || tx.currency === payment.currency;
    const received = Number.isFinite(tx.amount) ? tx.amount : Number(payment.amount);
    if (!sameCurrency || received !== Number(payment.amount)) flags = withFlag(flags, FLAGS.AMOUNT_MISMATCH);
    if (payment.mode === 'test') flags = withFlag(flags, FLAGS.TEST_PAYMENT);

    const wasPaid = isPaid(order) && Number(order.amountPaid) > 0;
    if (wasPaid) flags = withFlag(flags, FLAGS.DUPLICATE_PAYMENT);

    let reopened = false;
    if (order.cancelledAt) {
      if (order.cancellationReason === EXPIRED_REASON && (await reReserveStock(order, transaction))) {
        reopened = true;
      } else {
        flags = withFlag(flags, order.cancellationReason === EXPIRED_REASON ? FLAGS.PAID_AFTER_EXPIRY : FLAGS.PAID_AFTER_CANCEL);
      }
    } else if (order.paymentMethod === 'cod') {
      flags = withFlag(flags, FLAGS.PAID_AFTER_COD_SWITCH);
    }

    await payment.update(
      {
        status: 'captured',
        amount: sameCurrency ? received : payment.amount,
        providerTransactionId: tx.transactionId,
        maskedDisplay: tx.maskedDisplay,
        paidAt: new Date(),
        failureReason: null,
      },
      { transaction }
    );

    const amountPaid = Number(order.amountPaid) + (sameCurrency ? received : 0);
    const updates = { amountPaid, riskFlags: flags };
    if (reopened) {
      updates.cancelledAt = null;
      updates.cancellationReason = null;
    }
    if (!order.cancelledAt || reopened) updates.paymentExpiresAt = null;
    await order.update(updates, { transaction });

    if (sameCurrency && !wasPaid) {
      await setFinancialState(
        order.workspaceId,
        order.id,
        amountPaid >= Number(order.totalAmount) ? 'paid' : 'partially_paid',
        null,
        transaction
      );
    }

    // The order becomes a sale now — unless it stays cancelled (the merchant
    // refunds it) or was already one (a COD switch, a duplicate).
    const standing = !order.cancelledAt || reopened;
    if (standing && !order.completedAt) {
      const context = order.completionContext || {};
      await completeOrderInTransaction(order, { discount: context.discount || null, lateRedemption: true }, transaction);
      completed.value = { order, context };
    }

    await recordAudit({
      workspaceId: order.workspaceId,
      actorUserId: null,
      action: reopened ? 'order.reopened_after_payment' : 'order.payment_received',
      entityType: 'Order',
      entityId: order.id,
      before,
      after: {
        paymentId: payment.id,
        providerCode: payment.providerCode,
        amount: received,
        currency: tx.currency || payment.currency,
        mode: payment.mode,
        amountPaid,
        riskFlags: flags,
      },
      transaction,
    });

    return reopened ? 'paid_reopened' : 'paid';
  });

  if (completed.value) {
    const { order, context } = completed.value;
    await afterOrderCompleted(order.workspaceId, order, {
      cartId: context.cartId || null,
      checkoutSessionId: context.checkoutSessionId || null,
    });
  }
  return { outcome, ...ids };
}

// ------------------------------------------------------------------ inquiry

/**
 * Asks the gateway about one attempt and records what it says, through the
 * same inbox as a callback. Returns the normalized transaction, or null when
 * the gateway has none. Throws when the gateway cannot answer.
 */
async function inquireAttempt(attempt) {
  if (!attempt.providerOrderId) return null;
  const ctx = await gatewayRuntime.contextFor(attempt.workspaceId, attempt.providerCode);
  await db.Payment.update({ lastInquiredAt: new Date() }, { where: { id: attempt.id } });
  const result = await ctx.adapter.inquire(ctx.credentials, { payment: attempt });
  if (!result.found) return null;
  await require('./paymentEventService').ingest(
    { id: ctx.account.id, workspaceId: attempt.workspaceId, providerCode: attempt.providerCode },
    {
      eventKey: `inquiry:${attempt.providerOrderId}:${result.transaction.transactionId}:${result.transaction.status}`,
      transaction: result.transaction,
      payload: result.payload || {},
    },
    'inquiry'
  );
  return result.transaction;
}

/**
 * Inquires every attempt of an order that could still turn into a payment.
 * `throttle` skips attempts asked about in the last few seconds (the
 * shopper's status polling). Returns { unknown } — how many could not be
 * answered.
 */
async function inquireOpenAttempts(orderId, { throttle = false } = {}) {
  const attempts = await db.Payment.findAll({
    where: { orderId, status: OPEN_ATTEMPT, providerOrderId: { [Op.ne]: null } },
    order: [['createdAt', 'ASC']],
  });
  let unknown = 0;
  for (const attempt of attempts) {
    if (!gateways.isGateway(attempt.providerCode)) continue;
    if (throttle && attempt.lastInquiredAt && Date.now() - new Date(attempt.lastInquiredAt).getTime() < INQUIRY_THROTTLE_MS) {
      continue;
    }
    try {
      await inquireAttempt(attempt);
    } catch (err) {
      unknown += 1;
      logger.warn('Payment inquiry failed', { orderId, attemptId: attempt.id, code: err.code, reason: err.message });
    }
  }
  return { unknown };
}

// ------------------------------------------------------------------- expiry

/**
 * Expires one overdue unpaid online order: the gateway is asked about every
 * open attempt first, and nothing expires while any answer is missing — an
 * order must never be cancelled while its payment might have gone through.
 *
 * `skipLocked`: the sweep passes true so two sweeps (or a sweep and a
 * shopper) never wait on each other; a locked order is simply skipped.
 *
 * @returns {'expired'|'paid'|'not_due'|'unknown'|'locked'}
 */
async function expireOrder(orderId, { skipLocked = false } = {}) {
  const order = await db.Order.findByPk(orderId);
  if (!order || !order.paymentExpiresAt || order.cancelledAt) return 'not_due';
  if (isPaid(order) || order.paymentMethod === 'cod') return 'not_due';
  if (new Date(order.paymentExpiresAt).getTime() > Date.now()) return 'not_due';

  const { unknown } = await inquireOpenAttempts(order.id);
  if (unknown > 0) return 'unknown';

  return db.sequelize.transaction(async (transaction) => {
    const locked = await db.Order.findOne({
      where: { id: orderId },
      transaction,
      lock: transaction.LOCK.UPDATE,
      ...(skipLocked ? { skipLocked: true } : {}),
    });
    if (!locked) return 'locked';
    if (isPaid(locked) || locked.cancelledAt || locked.paymentMethod === 'cod' || !locked.paymentExpiresAt) {
      return isPaid(locked) ? 'paid' : 'not_due';
    }
    if (new Date(locked.paymentExpiresAt).getTime() > Date.now()) return 'not_due';

    await releaseStock(locked, transaction, 'order_payment_expired');
    await db.Payment.update(
      { status: 'expired' },
      { where: { orderId: locked.id, status: OPEN_ATTEMPT }, transaction }
    );
    await locked.update({ cancelledAt: new Date(), cancellationReason: EXPIRED_REASON }, { transaction });
    await recordAudit({
      workspaceId: locked.workspaceId,
      actorUserId: null,
      action: 'order.payment_expired',
      entityType: 'Order',
      entityId: locked.id,
      after: { cancelledAt: locked.cancelledAt, cancellationReason: EXPIRED_REASON },
      transaction,
    });
    return 'expired';
  });
}

/**
 * Lazy expiry ahead of a storefront checkout: overdue unpaid orders holding
 * any of these variants give their stock back first. Bounded, and never
 * fails the checkout.
 */
async function expireOverdueHolding(workspaceId, variantIds, { limit = 3 } = {}) {
  if (!env.payments.onlineEnabled || variantIds.length === 0) return;
  try {
    const overdue = await db.sequelize.query(
      `SELECT DISTINCT o.id, o.payment_expires_at
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
        WHERE o.workspace_id = $workspaceId
          AND o.payment_expires_at IS NOT NULL
          AND o.payment_expires_at < now()
          AND o.cancelled_at IS NULL
          AND o.payment_method <> 'cod'
          AND oi.variant_id = ANY($variantIds::uuid[])
        ORDER BY o.payment_expires_at
        LIMIT $limit`,
      { bind: { workspaceId, variantIds, limit }, type: db.Sequelize.QueryTypes.SELECT }
    );
    for (const row of overdue) await expireOrder(row.id, { skipLocked: true });
  } catch (err) {
    logger.warn('Lazy payment expiry failed', { workspaceId, reason: err.message });
  }
}

// ---------------------------------------------------------- shopper actions

async function loadOrderForShopper(workspaceId, orderId, token) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  // Same 404 for a wrong token as for no order: the id alone reveals nothing.
  if (!order || !tokenMatches(order, token)) throw new NotFoundError('Order');
  return order;
}

function shopperStatusOf(order) {
  if (isPaid(order) && Number(order.amountPaid) > 0) return 'paid';
  if (order.cancelledAt) return order.cancellationReason === EXPIRED_REASON ? 'expired' : 'cancelled';
  if (order.paymentMethod === 'cod') return 'cod';
  return 'awaiting_payment';
}

async function describeForShopper(order, workspace, preview) {
  const attempts = await db.Payment.findAll({ where: { orderId: order.id }, order: [['createdAt', 'DESC']] });
  const latest = attempts[0] || null;
  const status = shopperStatusOf(order);
  const offered = await methodsService.storefrontMethods(workspace, { preview });
  const online = offered.filter((m) => m.id !== methodsService.COD);
  const awaiting = status === 'awaiting_payment';
  const retriesLeft = Math.max(0, env.payments.maxAttemptsPerOrder - attempts.length);

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status,
    financialState: order.financialState,
    paymentMethod: order.paymentMethod,
    totalAmount: Number(order.totalAmount),
    amountPaid: Number(order.amountPaid),
    currency: order.currency,
    expiresAt: order.paymentExpiresAt,
    testMode: Boolean(latest && latest.mode === 'test'),
    attempt: latest
      ? {
          id: latest.id,
          status: latest.status,
          provider: latest.providerCode,
          method: latest.method,
          mode: latest.mode,
          // Only while the shopper can still use it.
          redirectUrl: awaiting && latest.status === OPEN_ATTEMPT ? latest.redirectUrl : null,
          failureReason: latest.status === 'failed' ? latest.failureReason : null,
          createdAt: latest.createdAt,
        }
      : null,
    canRetry: awaiting && retriesLeft > 0 && online.length > 0,
    retriesLeft,
    canSwitchToCod: awaiting && offered.some((m) => m.id === methodsService.COD),
    methods: awaiting ? online : [],
  };
}

async function publicWorkspace(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  return workspace;
}

/**
 * The shopper's view of their order's payment. `refresh` asks the gateway
 * about open attempts (throttled); an overdue order is expired on the spot.
 */
async function getShopperStatus(workspaceId, orderId, token, { refresh = false, req } = {}) {
  let order = await loadOrderForShopper(workspaceId, orderId, token);
  if (shopperStatusOf(order) === 'awaiting_payment') {
    if (refresh) await inquireOpenAttempts(order.id, { throttle: true });
    order = await db.Order.findByPk(order.id);
    if (shopperStatusOf(order) === 'awaiting_payment' && order.paymentExpiresAt && new Date(order.paymentExpiresAt) < new Date()) {
      await expireOrder(order.id);
      order = await db.Order.findByPk(order.id);
    }
  }
  const workspace = await publicWorkspace(workspaceId);
  return describeForShopper(order, workspace, req ? methodsService.isPreviewRequest(req, workspaceId) : false);
}

/**
 * The shopper came back from the gateway. The redirect's query string is
 * signed like a callback; a valid one is recorded at once, anything else
 * falls back to asking the gateway.
 */
async function handleReturn(workspaceId, orderId, token, query, req) {
  const order = await loadOrderForShopper(workspaceId, orderId, token);
  const attempts = await db.Payment.findAll({ where: { orderId: order.id }, order: [['createdAt', 'DESC']] });
  const providers = [...new Set(attempts.map((a) => a.providerCode).filter((c) => gateways.isGateway(c)))];

  let recorded = false;
  for (const provider of providers) {
    if (!query || typeof query !== 'object') break;
    try {
      const ctx = await gatewayRuntime.contextFor(workspaceId, provider);
      const parsed = ctx.adapter.parseRedirect(query, ctx.credentials);
      if (!parsed || !parsed.valid) continue;
      // Only a transaction on one of THIS order's attempts counts here.
      if (!attempts.some((a) => a.providerOrderId && a.providerOrderId === parsed.transaction.providerOrderId)) continue;
      await require('./paymentEventService').ingest(
        { id: ctx.account.id, workspaceId, providerCode: provider },
        parsed,
        'redirect'
      );
      recorded = true;
      break;
    } catch (err) {
      logger.warn('Could not use the payment redirect', { workspaceId, orderId, provider, reason: err.message });
    }
  }
  return getShopperStatus(workspaceId, orderId, token, { refresh: !recorded, req });
}

/** Another attempt, with the same or another online method. */
async function retry(workspaceId, orderId, token, body, req) {
  assertOnlineEnabled();
  const workspace = await publicWorkspace(workspaceId);
  let order = await loadOrderForShopper(workspaceId, orderId, token);

  // Anything that may already have been paid is settled first.
  await inquireOpenAttempts(order.id);
  order = await db.Order.findByPk(order.id);
  assertAwaiting(order);

  const preview = methodsService.isPreviewRequest(req, workspaceId);
  const method = await methodsService.resolveStorefrontMethod(
    workspace,
    { paymentMethod: body.paymentMethod || order.paymentMethod, paymentProvider: body.paymentProvider },
    { preview }
  );
  if (method.id === methodsService.COD) {
    throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 'Use switch-to-cod for cash on delivery', 422);
  }

  const lastAttempt = await db.Payment.findOne({ where: { orderId: order.id }, order: [['createdAt', 'DESC']] });
  const returnUrl = await assertReturnUrl(workspaceId, body.returnUrl || (lastAttempt && lastAttempt.returnUrl));

  const started = await db.sequelize.transaction(async (transaction) => {
    const locked = await db.Order.findOne({ where: { id: order.id }, transaction, lock: transaction.LOCK.UPDATE });
    assertAwaiting(locked);
    const count = await db.Payment.count({ where: { orderId: locked.id }, transaction });
    if (count >= env.payments.maxAttemptsPerOrder) {
      throw new AppError('PAYMENT_RETRY_LIMIT', 'This order cannot start another payment. Choose cash on delivery or place a new order.', 409);
    }
    await db.Payment.update({ status: 'cancelled' }, { where: { orderId: locked.id, status: OPEN_ATTEMPT }, transaction });
    // The retry gets a full window of its own; the attempt cap bounds how long
    // one order can hold its stock this way.
    const expiresAt = new Date(Date.now() + env.payments.attemptTtlMinutes * 60 * 1000);
    await locked.update({ paymentMethod: method.method, paymentExpiresAt: expiresAt }, { transaction });
    return locked;
  });

  await startAttempt(started, { provider: method.provider, method: method.method, returnUrl });
  return getShopperStatus(workspaceId, orderId, token, { req });
}

function assertAwaiting(order) {
  const status = shopperStatusOf(order);
  if (status === 'paid') throw new AppError('ORDER_ALREADY_PAID', 'This order has already been paid', 409);
  if (status === 'expired') throw new AppError('ORDER_PAYMENT_EXPIRED', 'The time to pay for this order has run out', 409);
  if (status === 'cancelled') throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
  if (status === 'cod') throw new AppError('ORDER_IS_COD', 'This order is already cash on delivery', 409);
  if (order.paymentExpiresAt && new Date(order.paymentExpiresAt) < new Date()) {
    throw new AppError('ORDER_PAYMENT_EXPIRED', 'The time to pay for this order has run out', 409);
  }
}

/**
 * The shopper gives up on paying online and pays on delivery instead. The
 * order becomes a COD order in every respect: a confirmation task, the
 * order-completed step, no expiry. Refused when the store's fraud rules would
 * have blocked it as a COD order in the first place (decision: for online
 * payments a rule's "block" only flags — paying cash is not online).
 */
async function switchToCod(workspaceId, orderId, token, req) {
  const workspace = await publicWorkspace(workspaceId);
  let order = await loadOrderForShopper(workspaceId, orderId, token);

  const preview = methodsService.isPreviewRequest(req, workspaceId);
  if (!(await methodsService.codOffered(workspace, { preview }))) {
    throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 'This store does not take cash on delivery', 422);
  }

  await inquireOpenAttempts(order.id);
  order = await db.Order.findByPk(order.id);
  assertAwaiting(order);

  const rules = fraudRules.resolveFraudRules(workspace.settings);
  const ruleFlags = Object.values(fraudRules.FLAGS);
  const flagged = (order.riskFlags || []).filter((f) => ruleFlags.includes(f));
  if (rules.action === 'block' && flagged.length > 0) {
    await recordAudit({
      workspaceId,
      action: 'order.blocked',
      entityType: 'Order',
      entityId: order.id,
      after: { flags: flagged, on: 'switch_to_cod' },
      req,
    });
    throw new fraudRules.OrderRejectedError({ customerId: order.customerId, flags: flagged });
  }

  const completed = await db.sequelize.transaction(async (transaction) => {
    const locked = await db.Order.findOne({ where: { id: order.id }, transaction, lock: transaction.LOCK.UPDATE });
    assertAwaiting(locked);
    const before = { paymentMethod: locked.paymentMethod };

    await db.Payment.update({ status: 'cancelled' }, { where: { orderId: locked.id, status: OPEN_ATTEMPT }, transaction });
    await locked.update({ paymentMethod: 'cod', paymentExpiresAt: null }, { transaction });
    await db.ConfirmationTask.create({ workspaceId, orderId: locked.id, status: 'queued' }, { transaction });

    const context = locked.completionContext || {};
    await completeOrderInTransaction(locked, { discount: context.discount || null, lateRedemption: true }, transaction);

    await recordAudit({
      workspaceId,
      actorUserId: null,
      action: 'order.switched_to_cod',
      entityType: 'Order',
      entityId: locked.id,
      before,
      after: { paymentMethod: 'cod' },
      req,
      transaction,
    });
    return { order: locked, context };
  });

  await afterOrderCompleted(workspaceId, completed.order, {
    cartId: completed.context.cartId || null,
    checkoutSessionId: completed.context.checkoutSessionId || null,
  });
  return getShopperStatus(workspaceId, orderId, token, { req });
}

module.exports = {
  FLAGS,
  EXPIRED_REASON,
  PAID_STATES,
  assertReturnUrl,
  prepareOnlineCheckout,
  startAttempt,
  recordPaymentTransaction,
  inquireAttempt,
  inquireOpenAttempts,
  expireOrder,
  expireOverdueHolding,
  getShopperStatus,
  handleReturn,
  retry,
  switchToCod,
  shopperStatusOf,
  hashToken,
};
