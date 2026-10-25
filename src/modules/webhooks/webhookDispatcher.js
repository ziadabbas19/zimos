'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { signatureHeader } = require('./webhookSigning');
const { readSecret } = require('./signingSecretStore');
const { send } = require('./webhookSender');
const { revealsByEndpoint, maskCustomerData } = require('./customerData');

/**
 * Sends what is due from webhook_deliveries — the outbox the change detector
 * (and the "Send test" button) writes into.
 *
 * A delivery is attempted until the receiver answers 2xx, with growing gaps
 * between tries (BACKOFF_MINUTES: a minute, then 5, 30, 2h, 6h, 12h, 24h) —
 * eight attempts over about two days, after which it is `exhausted` and
 * waits for the merchant to press "Redeliver". In between it is `failed`
 * with next_attempt_at set.
 *
 * Due rows are claimed with FOR UPDATE SKIP LOCKED and leased (next_attempt_at
 * pushed LEASE_MS ahead) before anything is sent, the pattern
 * carrierSyncService uses — so the in-process loop and the cron script can
 * run together without ever sending one delivery twice at once. A process
 * that dies mid-send just lets the lease run out; the row comes due again.
 *
 * Every attempt carries the same event id (X-Zimos-Event-Id): a receiver that
 * got the first attempt but answered too slowly will see the retry and can
 * recognise it as the same event.
 */

const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 720, 1440];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const LEASE_MS = 2 * 60 * 1000;
const CONCURRENCY = 5;
const USER_AGENT = 'Zimos-Webhooks/1.0';
const SECRET_RETRY_MS = 5 * 60 * 1000;
// How long a delivery keeps waiting for its secret to become readable before it ends.
const SECRET_GIVE_UP_MS = 3 * 24 * 60 * 60 * 1000;

async function claimDue({ limit, now }) {
  const rows = await db.sequelize.query(
    `UPDATE webhook_deliveries d
        SET next_attempt_at = :lease, updated_at = :now
      WHERE d.id IN (
              SELECT id FROM webhook_deliveries
               WHERE status IN ('pending', 'failed')
                 AND next_attempt_at IS NOT NULL
                 AND next_attempt_at <= :now
               ORDER BY next_attempt_at
               LIMIT :limit
               FOR UPDATE SKIP LOCKED)
  RETURNING d.id`,
    { replacements: { now, lease: new Date(now.getTime() + LEASE_MS), limit }, type: QueryTypes.SELECT }
  );
  return rows.map((row) => row.id);
}

/**
 * Attempts one delivery now, whatever its schedule, and records the outcome.
 * Used by the loop for claimed rows and directly by "Send test" and
 * "Redeliver". Returns the updated row.
 */
async function attemptDelivery(deliveryId, { now = new Date() } = {}) {
  const delivery = await db.WebhookDelivery.findByPk(deliveryId, {
    include: [{ model: db.WebhookEndpoint, as: 'endpoint' }],
  });
  if (!delivery) return null;
  const { endpoint } = delivery;

  // A paused endpoint keeps its backlog instead of losing it: the row stops
  // being scheduled until the merchant resumes the endpoint and redelivers.
  if (!endpoint || !endpoint.isActive) {
    await delivery.update({ status: 'failed', nextAttemptAt: null, lastError: 'Endpoint is paused' });
    return delivery;
  }

  // order.accepted is news only while it is still true. A receiver that was
  // down gets the retry hours later: an order cancelled in between is not
  // sent as accepted. The row ends (exhausted) saying why; Redeliver asks again.
  if (delivery.eventType === 'order.accepted') {
    const order = delivery.payload && delivery.payload.data && delivery.payload.data.order;
    const acceptance = order && order.id ? await require('../orders/orderAccepted').acceptanceOf(delivery.workspaceId, order.id) : null;
    if (!acceptance || !acceptance.accepted) {
      await delivery.update({ status: 'exhausted', nextAttemptAt: null, lastError: 'Not sent: the order is no longer accepted (cancelled since)' });
      return delivery;
    }
  }

  // A sealed secret this server cannot open (WEBHOOK_SECRETS_KEY missing or
  // changed): nothing is sent unsigned, and the attempt is not counted
  // against the receiver — it comes due again until the key is back.
  // Three days of that and the row ends (exhausted) instead of coming back
  // every 5 minutes for ever; Redeliver sends it once the key is back. A row
  // with no secret at all (both columns empty, which the CHECK of migration
  // 714 refuses) is treated the same way.
  let secret;
  try {
    secret = readSecret(endpoint);
    if (!secret) throw new Error('No signing secret is stored for this endpoint');
  } catch (err) {
    logger.error('Webhook signing secret unreadable', { endpointId: endpoint.id, workspaceId: endpoint.workspaceId, reason: err.message });
    const giveUp = now.getTime() - new Date(delivery.createdAt).getTime() >= SECRET_GIVE_UP_MS;
    await delivery.update(
      giveUp
        ? { status: 'exhausted', nextAttemptAt: null, lastError: 'The signing secret could not be read on our side for 3 days: not sent' }
        : { status: 'failed', nextAttemptAt: new Date(now.getTime() + SECRET_RETRY_MS), lastError: 'The signing secret could not be read on our side; retried automatically' }
    );
    return delivery;
  }

  // Customers go out in full only while the endpoint's configurer may see
  // them now (customerData.js), whatever the row was stored with: an address
  // changed by a teammate without customers.reveal_sensitive, then a retry
  // still due, a Redeliver or a Resend, sends the stored row masked. The row
  // then keeps what was sent, as the payload cap does.
  const reveals = (await revealsByEndpoint(endpoint.workspaceId, [endpoint])).get(endpoint.id);
  const payload = reveals ? delivery.payload : maskCustomerData(delivery.payload);
  const body = JSON.stringify(payload);
  const masked = body !== JSON.stringify(delivery.payload);
  const timestamp = Math.floor(now.getTime() / 1000);
  const result = await send({
    url: endpoint.url,
    body,
    timeoutMs: env.webhooks.timeoutMs,
    headers: {
      // The merchant's own headers first; ours below always win (customHeaders.js).
      ...require('./customHeaders').forSend(endpoint.customHeaders),
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-Zimos-Event': delivery.eventType,
      'X-Zimos-Event-Id': delivery.eventId,
      'X-Zimos-Delivery-Id': delivery.id,
      'X-Zimos-Timestamp': String(timestamp),
      'X-Zimos-Signature': signatureHeader(secret, timestamp, body),
    },
  });

  const attemptCount = delivery.attemptCount + 1;
  const ok = result.status !== null && result.status >= 200 && result.status < 300;
  let changes;
  if (ok) {
    changes = { status: 'delivered', nextAttemptAt: null, lastError: null };
  } else if (attemptCount >= MAX_ATTEMPTS) {
    changes = { status: 'exhausted', nextAttemptAt: null };
  } else {
    const waitMinutes = BACKOFF_MINUTES[attemptCount - 1];
    changes = { status: 'failed', nextAttemptAt: new Date(now.getTime() + waitMinutes * 60 * 1000) };
  }
  if (!ok) {
    changes.lastError = (result.error || `Receiver answered HTTP ${result.status}`).slice(0, 500);
  }

  await delivery.update({ ...changes, attemptCount, lastResponseStatus: result.status, ...(masked ? { payload } : {}) });
  // Three days of nothing but failures switches the endpoint off (webhookHealth.js).
  await require('./webhookHealth').recordOutcome(endpoint, ok, now);
  return delivery;
}

/** One batch of due deliveries. */
async function deliverDueOnce({ limit = env.webhooks.batchSize, now = new Date() } = {}) {
  const ids = await claimDue({ limit, now });
  const tally = { attempted: ids.length, delivered: 0, failed: 0 };
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const results = await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => attemptDelivery(id, { now })));
    for (const row of results) {
      if (row && row.status === 'delivered') tally.delivered += 1;
      else tally.failed += 1;
    }
  }
  return tally;
}

/** Batches until nothing more is due (at most maxBatches, so one pass can't run forever). */
async function deliverDue({ limit = env.webhooks.batchSize, maxBatches = 20, now } = {}) {
  const total = { attempted: 0, delivered: 0, failed: 0 };
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await deliverDueOnce({ limit, now: now || new Date() });
    total.attempted += batch.attempted;
    total.delivered += batch.delivered;
    total.failed += batch.failed;
    if (batch.attempted < limit) break;
  }
  return total;
}

module.exports = { attemptDelivery, deliverDueOnce, deliverDue, BACKOFF_MINUTES, MAX_ATTEMPTS };
