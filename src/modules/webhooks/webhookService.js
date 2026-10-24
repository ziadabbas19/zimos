'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { checkUrl } = require('./webhookUrlGuard');
const { generateSecret } = require('./webhookSigning');
const secretStore = require('./signingSecretStore');
const { EVENT_TYPES, TEST_EVENT, WILDCARD, EXPLICIT_ONLY } = require('./webhookEvents');
const { attemptDelivery } = require('./webhookDispatcher');
const { normaliseFilter } = require('./webhookFilter');
const customerData = require('./customerData');

/**
 * A workspace's webhook endpoints, as the dashboard manages them.
 *
 * The signing secret is shown in full twice only: when the endpoint is
 * created and when it is rotated. Every other read shows a hint (its last
 * four characters). It is stored as-is rather than hashed — unlike an API key
 * we need it back, to sign every request.
 */

const MAX_ENDPOINTS_PER_WORKSPACE = 10;

/**
 * `sendsCustomerData`: whether this endpoint's deliveries carry customers in
 * full (customerData.js) — false when the teammate who last set its address
 * does not hold customers.reveal_sensitive or has left. Known only where the
 * caller worked it out; absent otherwise.
 */
function serializeEndpoint(endpoint, reveals) {
  return {
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    isActive: endpoint.isActive,
    filter: endpoint.filter || null,
    // Names with masked values; the values are sealed (customHeaders.js).
    ...(require('./customHeaders').on() ? { customHeaders: require('./customHeaders').view(endpoint.customHeaders) } : {}),
    failingSince: endpoint.failingSince || null,
    // Set when the endpoint was switched off after three days of failures.
    disabledAt: endpoint.disabledAt || null,
    disabledReason: endpoint.disabledReason || null,
    secretHint: secretStore.hintFor(endpoint),
    ...(reveals instanceof Map ? { sendsCustomerData: reveals.get(endpoint.id) === true } : {}),
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

/** The endpoint as the dashboard shows it, with whether it is sent customers in full. */
async function present(workspaceId, endpoint) {
  return serializeEndpoint(endpoint, await customerData.revealsByEndpoint(workspaceId, [endpoint]));
}

/**
 * A delivery as the log shows it. `reveal`: whether the viewer holds
 * customers.reveal_sensitive; without it the payload's names, phones, emails
 * and addresses are masked, whatever the endpoint itself was sent.
 */
function serializeDelivery(delivery, { reveal = false } = {}) {
  return {
    id: delivery.id,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    nextAttemptAt: delivery.nextAttemptAt,
    lastResponseStatus: delivery.lastResponseStatus,
    lastError: delivery.lastError,
    payload: reveal ? delivery.payload : customerData.maskCustomerData(delivery.payload),
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

async function findEndpoint(workspaceId, endpointId, transaction) {
  const endpoint = await db.WebhookEndpoint.findOne({
    where: { id: endpointId, workspaceId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!endpoint) throw new NotFoundError('WebhookEndpoint');
  return endpoint;
}

/**
 * An endpoint's address as the activity log keeps it: the scheme and host,
 * and a short fingerprint of the whole URL so two different addresses on one
 * host can be told apart. Never the path or the query: a receiver's secret
 * often lives there (an Apps Script `?token=`, a Zapier or Make hook id), and
 * anyone with audit_log.view reads the log.
 */
function auditUrl(url) {
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    origin = '';
  }
  const fingerprint = crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 8);
  return `${origin}/… #${fingerprint}`;
}

/**
 * '*' stands alone: an endpoint listening to everything lists nothing else —
 * but the events '*' leaves out (order.accepted, webhookEvents.js), which it
 * keeps beside it.
 */
const normaliseEvents = (events) =>
  events.includes(WILDCARD) ? [WILDCARD, ...new Set(events.filter((e) => EXPLICIT_ONLY.has(e)))] : [...new Set(events)];

function eventCatalogue() {
  return {
    events: Object.entries(EVENT_TYPES).map(([name, description]) => ({ name, description })),
    wildcard: WILDCARD,
    // Events '*' does not bring: an endpoint lists them by name, beside '*' if it likes.
    explicitOnly: [...EXPLICIT_ONLY],
  };
}

async function listEndpoints(workspaceId) {
  const endpoints = await db.WebhookEndpoint.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  const reveals = await customerData.revealsByEndpoint(workspaceId, endpoints);
  return { endpoints: endpoints.map((e) => serializeEndpoint(e, reveals)), ...eventCatalogue() };
}

async function createEndpoint(workspaceId, { url, events, isActive = true, filter = null, customHeaders = [] }, req) {
  const cleanUrl = checkUrl(url);
  return db.sequelize.transaction(async (transaction) => {
    const count = await db.WebhookEndpoint.count({ where: { workspaceId }, transaction });
    if (count >= MAX_ENDPOINTS_PER_WORKSPACE) {
      throw new AppError(
        'WEBHOOK_ENDPOINT_LIMIT',
        `A store can have at most ${MAX_ENDPOINTS_PER_WORKSPACE} webhook endpoints`,
        409
      );
    }
    const signingSecret = generateSecret();
    // The id is known before the row is written: a sealed secret is bound to it.
    const id = crypto.randomUUID();
    const endpoint = await db.WebhookEndpoint.create(
      {
        id,
        workspaceId,
        url: cleanUrl,
        // Whose role decides whether its deliveries carry customers in full (customerData.js).
        configuredByUserId: req.user.id,
        events: normaliseEvents(events),
        ...secretStore.storedFields(workspaceId, id, signingSecret),
        isActive,
        filter: normaliseFilter(filter),
        customHeaders: require('./customHeaders').on() ? require('./customHeaders').normalise(customHeaders) : [],
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'webhook_endpoint.create',
      entityType: 'WebhookEndpoint',
      entityId: endpoint.id,
      req,
      after: { url: auditUrl(endpoint.url), events: endpoint.events, isActive: endpoint.isActive },
      transaction,
    });
    return { endpoint: serializeEndpoint(endpoint, await customerData.revealsByEndpoint(workspaceId, [endpoint])), signingSecret };
  });
}

async function updateEndpoint(workspaceId, endpointId, changes, req) {
  return db.sequelize.transaction(async (transaction) => {
    const endpoint = await findEndpoint(workspaceId, endpointId, transaction);
    const before = { url: auditUrl(endpoint.url), events: endpoint.events, isActive: endpoint.isActive };
    const next = {};
    // Setting the address — even to the same one — makes this teammate the
    // one whose role decides what it is sent (customerData.js).
    if (changes.url !== undefined) Object.assign(next, { url: checkUrl(changes.url), configuredByUserId: req.user.id });
    if (changes.events !== undefined) next.events = normaliseEvents(changes.events);
    if (changes.isActive !== undefined) next.isActive = changes.isActive;
    if (changes.filter !== undefined) next.filter = normaliseFilter(changes.filter);
    // The whole list; { name, keep: true } keeps a stored value (customHeaders.js).
    if (changes.customHeaders !== undefined && require('./customHeaders').on()) next.customHeaders = require('./customHeaders').normalise(changes.customHeaders, endpoint.customHeaders);
    // Turning it back on starts with a clean record.
    if (changes.isActive === true) Object.assign(next, { failingSince: null, disabledAt: null, disabledReason: null });
    await endpoint.update(next, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'webhook_endpoint.update',
      entityType: 'WebhookEndpoint',
      entityId: endpoint.id,
      req,
      before,
      after: { url: auditUrl(endpoint.url), events: endpoint.events, isActive: endpoint.isActive },
      transaction,
    });
    return present(workspaceId, endpoint);
  });
}

/** Deleting an endpoint deletes its delivery history with it (FK cascade). */
async function deleteEndpoint(workspaceId, endpointId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const endpoint = await findEndpoint(workspaceId, endpointId, transaction);
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'webhook_endpoint.delete',
      entityType: 'WebhookEndpoint',
      entityId: endpoint.id,
      req,
      before: { url: auditUrl(endpoint.url), events: endpoint.events },
      transaction,
    });
    await endpoint.destroy({ transaction });
    return { deleted: true };
  });
}

/**
 * A new secret, effective for the next request sent. The old one stops
 * verifying at once, so the merchant updates their receiver right after.
 */
async function rotateSecret(workspaceId, endpointId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const endpoint = await findEndpoint(workspaceId, endpointId, transaction);
    const signingSecret = generateSecret();
    await endpoint.update(secretStore.storedFields(workspaceId, endpoint.id, signingSecret), { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'webhook_endpoint.rotate_secret',
      entityType: 'WebhookEndpoint',
      entityId: endpoint.id,
      req,
      transaction,
    });
    return { endpoint: await present(workspaceId, endpoint), signingSecret };
  });
}

/**
 * "Send test": a `webhook.test` event to this endpoint, sent right now, with
 * the outcome in the answer — so a merchant setting up their receiver sees
 * at once whether it answers and whether their signature check passes.
 * Goes through the outbox like any delivery, so it shows in the history and
 * is retried like one if the receiver was down.
 */
async function sendTest(workspaceId, endpointId, { reveal = false } = {}) {
  const endpoint = await findEndpoint(workspaceId, endpointId);
  const eventId = `${TEST_EVENT}:${crypto.randomUUID()}`;
  const now = new Date();
  const delivery = await db.WebhookDelivery.create({
    workspaceId,
    endpointId: endpoint.id,
    eventId,
    eventType: TEST_EVENT,
    payload: {
      id: eventId,
      type: TEST_EVENT,
      createdAt: now.toISOString(),
      workspaceId,
      data: { message: 'This is a test event from Zimos. If you can read this, your endpoint works.' },
    },
    status: 'pending',
    nextAttemptAt: null,
  });
  return serializeDelivery(await attemptDelivery(delivery.id, { now }), { reveal });
}

async function listDeliveries(workspaceId, endpointId, { limit = 50, status } = {}, { reveal = false } = {}) {
  await findEndpoint(workspaceId, endpointId);
  const where = { workspaceId, endpointId };
  if (status) where.status = status;
  const deliveries = await db.WebhookDelivery.findAll({ where, order: [['createdAt', 'DESC']], limit });
  return { deliveries: deliveries.map((d) => serializeDelivery(d, { reveal })) };
}

/** Sends one delivery again now — after a fix on the receiver's side, or to replay an event. */
async function redeliver(workspaceId, endpointId, deliveryId, { reveal = false } = {}) {
  const delivery = await db.WebhookDelivery.findOne({ where: { id: deliveryId, endpointId, workspaceId } });
  if (!delivery) throw new NotFoundError('WebhookDelivery');
  return serializeDelivery(await attemptDelivery(delivery.id), { reveal });
}

module.exports = {
  MAX_ENDPOINTS_PER_WORKSPACE,
  auditUrl,
  serializeDelivery,
  eventCatalogue,
  listEndpoints,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  rotateSecret,
  sendTest,
  listDeliveries,
  redeliver,
};
