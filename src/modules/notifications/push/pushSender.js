'use strict';

const webpush = require('web-push');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const pushConfig = require('./pushConfig');
const pushEndpoints = require('./pushEndpoints');
const pushPayload = require('./pushPayload');
const pushSessions = require('./pushSessions');

/**
 * Sends one notification to one device (web-push: encryption and the VAPID
 * signature), then records what the push service answered:
 *
 *   2xx              sent: last_success_at, failures back to 0
 *   404, 410         the browser dropped the subscription: the row is deleted
 *   429              throttled: `retry` after Retry-After, not counted as a failure
 *   413              the payload is too large (a bug here): counted, logged as an error
 *   other 4xx        e.g. 400/401/403, a VAPID problem: counted, not retried
 *   5xx, no answer   counted, `retry`
 *   5 failures in a row switch the device off (enabled = false); the row stays
 *   so "My devices" can show it.
 *
 * Before sending: push must be on, the endpoint must still be one of the push
 * services (pushEndpoints), the account active, and the device's session alive
 * (followed through any refresh, pushSessions.settle). A device that fails one
 * of the last three is deleted. The payload is built by pushPayload from an
 * allowlist; the endpoint is never logged.
 *
 * Answers { outcome, retryAfterMs? }: sent | gone | retry | failed | off | disabled.
 */

const MAX_FAILURES = 5;
const TIMEOUT_MS = 10 * 1000;
const URGENCIES = ['very-low', 'low', 'normal', 'high'];

function retryAfterMs(headers) {
  const raw = headers && (headers['retry-after'] || headers['Retry-After']);
  if (!raw) return null;
  if (/^\d+$/.test(String(raw).trim())) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function recordFailure(subscription, { error, status }) {
  const failureCount = subscription.failureCount + 1;
  const patch = { failureCount, lastError: String(error).slice(0, 200), lastFailureAt: new Date() };
  if (failureCount >= MAX_FAILURES) patch.enabled = false;
  await subscription.update(patch);
  if (patch.enabled === false) logger.warn(`Push device ${subscription.id} switched off after ${failureCount} failures (last: ${patch.lastError})`, { status });
}

async function stillDeliverable(subscription) {
  if (!pushEndpoints.serviceOf(subscription.endpoint)) return false;
  const user = await db.User.findByPk(subscription.userId, { attributes: ['id', 'status', 'deletedAt'] });
  if (!user || user.status !== 'active' || user.deletedAt) return false;
  const { removed } = await pushSessions.settle(subscription.id);
  return removed === 0;
}

/**
 * `message` is pushPayload.build's: { type, params, url, tag, count }, the text
 * in the device's own language. `options`: ttlSeconds, urgency, topic.
 */
async function send(subscription, message, { ttlSeconds = 60 * 60, urgency = 'normal', topic } = {}) {
  if (!pushConfig.isOn()) return { outcome: 'off' };
  if (!subscription.enabled) return { outcome: 'disabled' };
  if (!(await stillDeliverable(subscription))) {
    await db.PushSubscription.destroy({ where: { id: subscription.id } });
    return { outcome: 'gone' };
  }

  const payload = pushPayload.build(message.type, { ...message, locale: subscription.locale });
  const options = {
    vapidDetails: pushConfig.vapidDetails(),
    TTL: ttlSeconds,
    urgency: URGENCIES.includes(urgency) ? urgency : 'normal',
    timeout: TIMEOUT_MS,
  };
  if (typeof topic === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(topic)) options.topic = topic;

  try {
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, options);
  } catch (err) {
    const status = err && Number.isInteger(err.statusCode) ? err.statusCode : null;
    if (status === 404 || status === 410) {
      await db.PushSubscription.destroy({ where: { id: subscription.id } });
      return { outcome: 'gone' };
    }
    if (status === 429) {
      await subscription.update({ lastError: 'HTTP 429', lastFailureAt: new Date() });
      return { outcome: 'retry', retryAfterMs: retryAfterMs(err.headers) };
    }
    if (status === 413) logger.error(`Push payload refused as too large for device ${subscription.id} (type ${message.type})`);
    const error = status ? `HTTP ${status}` : (err && (err.code || err.message)) || 'send failed';
    await recordFailure(subscription, { error, status });
    return { outcome: status && status < 500 ? 'failed' : 'retry' };
  }

  await subscription.update({ failureCount: 0, lastError: null, lastSuccessAt: new Date() });
  return { outcome: 'sent' };
}

module.exports = { send, MAX_FAILURES };
