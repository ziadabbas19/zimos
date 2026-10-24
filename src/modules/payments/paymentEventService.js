'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');

/**
 * The payment callback inbox.
 *
 * Every signed callback, signed redirect and inquiry answer is written to
 * payment_events first, keyed (provider_code, event_key) — the same signed
 * content always has the same key, so a webhook redelivered, a redirect and a
 * webhook for the same transaction, or two concurrent deliveries collapse to
 * one row. Then the row is processed. Processing is idempotent on its own
 * (see onlinePaymentService.recordPaymentTransaction), so the inbox is about
 * record-keeping and retries, not correctness under duplicates.
 *
 * A row whose processing throws keeps processed_at NULL with the error; the
 * callback is still answered 200 (the event is safely stored) and the sweep
 * retries it (reprocessPending).
 */

const MAX_ATTEMPTS = 10;

async function insertEvent(account, parsed, source) {
  const tx = parsed.transaction || {};
  const [row] = await db.sequelize.query(
    `INSERT INTO payment_events
       (id, workspace_id, account_id, provider_code, event_key, source, kind, provider_order_id,
        provider_transaction_id, payload, created_at, updated_at)
     VALUES
       ($id, $workspaceId, $accountId, $providerCode, $eventKey, $source, $kind, $providerOrderId,
        $transactionId, $payload::jsonb, now(), now())
     ON CONFLICT (provider_code, event_key) DO NOTHING
     RETURNING id`,
    {
      bind: {
        id: crypto.randomUUID(),
        workspaceId: account.workspaceId,
        accountId: account.id || null,
        providerCode: account.providerCode,
        eventKey: String(parsed.eventKey).slice(0, 200),
        source,
        kind: tx.kind || null,
        providerOrderId: tx.providerOrderId || null,
        transactionId: tx.transactionId || null,
        payload: JSON.stringify(parsed.payload || {}),
      },
      type: QueryTypes.SELECT,
    }
  );
  if (row) return { event: await db.PaymentEvent.findByPk(row.id), created: true };
  const existing = await db.PaymentEvent.findOne({
    where: { providerCode: account.providerCode, eventKey: String(parsed.eventKey).slice(0, 200) },
  });
  return { event: existing, created: false };
}

/** Routes one stored event to the code that acts on it. */
async function dispatch(account, transaction) {
  const online = require('./onlinePaymentService');
  if (transaction.kind === 'payment') return online.recordPaymentTransaction(account, transaction);
  return require('./gatewayRefundService').recordRefundTransaction(account, transaction);
}

async function processEvent(account, event, transaction) {
  // Counts the try; a row already processed is left alone. Two deliveries
  // racing past this both dispatch, which is safe: recording is idempotent
  // under the payment row lock.
  const [claimed] = await db.PaymentEvent.update(
    { attempts: db.sequelize.literal('attempts + 1') },
    { where: { id: event.id, processedAt: null } }
  );
  if (!claimed) return { outcome: 'duplicate' };
  try {
    const result = await dispatch(account, transaction);
    await db.PaymentEvent.update(
      {
        processedAt: new Date(),
        outcome: result.outcome,
        paymentId: result.paymentId || null,
        orderId: result.orderId || null,
        error: null,
      },
      { where: { id: event.id } }
    );
    return result;
  } catch (err) {
    logger.error('Payment event processing failed; will retry', {
      eventId: event.id,
      providerCode: account.providerCode,
      reason: err.message,
    });
    await db.PaymentEvent.update({ error: String(err.message || 'error').slice(0, 500) }, { where: { id: event.id } });
    return { outcome: 'error' };
  }
}

/**
 * @param {object} account  { id, workspaceId, providerCode }
 * @param {object} parsed   { eventKey, transaction, payload } from the adapter
 * @param {'webhook'|'redirect'|'inquiry'} source
 */
async function ingest(account, parsed, source) {
  const { event, created } = await insertEvent(account, parsed, source);
  if (!event) return { outcome: 'duplicate' };
  if (!created && event.processedAt) return { outcome: 'duplicate', eventId: event.id };
  const result = await processEvent(account, event, parsed.transaction);
  return { ...result, eventId: event.id };
}

/**
 * The sweep's retry of events whose processing failed. The stored payload is
 * the adapter's storable subset, so the adapter re-normalizes it.
 */
async function reprocessPending({ limit = 50 } = {}) {
  const gateways = require('./gateways');
  const events = await db.PaymentEvent.findAll({
    where: { processedAt: null, attempts: { [db.Sequelize.Op.lt]: MAX_ATTEMPTS } },
    order: [['createdAt', 'ASC']],
    limit,
  });
  let processed = 0;
  for (const event of events) {
    const adapter = gateways.getAdapter(event.providerCode);
    if (!adapter || !adapter.normalizeTransaction) continue;
    const transaction = adapter.normalizeTransaction(event.payload || {});
    if (!transaction.providerOrderId && event.providerOrderId) transaction.providerOrderId = event.providerOrderId;
    const result = await processEvent(
      { id: event.accountId, workspaceId: event.workspaceId, providerCode: event.providerCode },
      event,
      transaction
    );
    if (result.outcome !== 'error' && result.outcome !== 'duplicate') processed += 1;
  }
  return { processed, seen: events.length };
}

/**
 * For a gateway whose webhook signature does not cover the outcome
 * (adapter.webhookConfirmsByInquiry — Fawaterak): the verified webhook only
 * names the payment, so the gateway is asked about it now, through the same
 * inbox as any inquiry. Never throws: a gateway that cannot be asked leaves
 * the attempt to the return page and the sweep.
 *
 * @returns {object|null} the gateway's transaction, or null
 */
async function confirmByInquiry(account, transaction) {
  if (!transaction || !transaction.providerOrderId) return null;
  const attempt = await db.Payment.findOne({
    where: { workspaceId: account.workspaceId, providerCode: account.providerCode, providerOrderId: transaction.providerOrderId },
  });
  if (!attempt || ['captured', 'partially_refunded', 'refunded'].includes(attempt.status)) return null;
  try {
    return await require('./onlinePaymentService').inquireAttempt(attempt);
  } catch (err) {
    logger.warn('Payment inquiry after a webhook failed; the sweep will ask again', {
      workspaceId: account.workspaceId,
      providerCode: account.providerCode,
      attemptId: attempt.id,
      reason: err.message,
    });
    return null;
  }
}

/**
 * POST /webhooks/payments/:code/:token[/:variant]. The token in the path
 * names the merchant's account; the signature is checked with that account's
 * secret. `variant` is a last path segment the adapter asked for
 * (webhookVariants: Fawaterak's `paid_json`). Resolves { statusCode, body }:
 *   404  unknown gateway, token or variant (nothing said about which) — thrown
 *   401  WEBHOOK_SIGNATURE_INVALID — thrown
 *   200  { received: true } — stored (and processed, or queued for a retry),
 *        or a callback type we do not act on
 *   409  { received: true, outcome: 'duplicate' } — a callback already
 *        processed, for a gateway that asks for that (Kashier); others get 200
 */
async function acceptWebhook(code, token, req, variant = null) {
  const gateways = require('./gateways');
  const accounts = require('./gatewayAccountService');
  const { AppError, NotFoundError } = require('../../core/errors/AppError');

  const adapter = gateways.getAdapter(code);
  if (!adapter) throw new NotFoundError('Webhook');
  if (variant !== null && !(adapter.webhookVariants || []).includes(variant)) throw new NotFoundError('Webhook');
  accounts.assertConfigured();
  const account = await accounts.findByWebhookToken(code, token);
  if (!account) throw new NotFoundError('Webhook');

  const parsed = adapter.parseWebhook({ query: req.query || {}, body: req.body, headers: req.headers || {} }, account.credentials);
  if (!parsed) return { statusCode: 200, body: { received: true, ignored: true } };
  if (!parsed.valid) {
    // Never log the received or expected signature.
    logger.warn('Payment webhook with an invalid signature', { workspaceId: account.workspaceId, providerCode: code });
    throw new AppError('WEBHOOK_SIGNATURE_INVALID', 'Signature does not match', 401);
  }

  await db.PaymentGatewayAccount.update({ lastWebhookAt: new Date() }, { where: { id: account.id } });
  const result = await ingest(account, parsed, 'webhook');
  if (adapter.webhookConfirmsByInquiry) {
    // Asked even for a repeat: the first delivery's inquiry may have found
    // the gateway unreachable, and recording is idempotent.
    const confirmed = await confirmByInquiry(account, parsed.transaction);
    return { statusCode: 200, body: { received: true, outcome: result.outcome, confirmed: confirmed ? confirmed.status : null } };
  }
  const statusCode = result.outcome === 'duplicate' && adapter.webhookDuplicateStatus ? adapter.webhookDuplicateStatus : 200;
  return { statusCode, body: { received: true, outcome: result.outcome } };
}

module.exports = { ingest, reprocessPending, acceptWebhook, MAX_ATTEMPTS };
