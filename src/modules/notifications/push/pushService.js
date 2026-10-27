'use strict';

const crypto = require('crypto');
const { Op, UniqueConstraintError } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const sessionGate = require('../../../core/security/sessionGate');
const { AppError, AuthenticationError, AuthorizationError, ConflictError, NotFoundError } = require('../../../core/errors/AppError');
const pushConfig = require('./pushConfig');
const pushEndpoints = require('./pushEndpoints');
const pushSender = require('./pushSender');
const pushSessions = require('./pushSessions');

/**
 * The account's devices for device notifications (/me/push, pushRoutes.js).
 * Every device is bound to the session it subscribed under (pushSessions).
 */

const STALE_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// Where the test notification opens, per app.
const TEST_URL = { dashboard: '/settings?tab=notifications', console: '/' };

const hashEndpoint = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex');

/** "Chrome on Windows" from a user agent, or null. Nothing else of it is kept. */
function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return null;
  const browser =
    (/Edg(e|A|iOS)?\//.test(ua) && 'Edge') ||
    (/SamsungBrowser\//.test(ua) && 'Samsung Internet') ||
    ((/OPR\//.test(ua) || /Opera/.test(ua)) && 'Opera') ||
    ((/Firefox\//.test(ua) || /FxiOS\//.test(ua)) && 'Firefox') ||
    ((/Chrome\//.test(ua) || /CriOS\//.test(ua)) && 'Chrome') ||
    (/Safari\//.test(ua) && 'Safari') ||
    null;
  const os =
    (/iPhone|iPad|iPod/.test(ua) && 'iOS') ||
    (/Android/.test(ua) && 'Android') ||
    (/Windows/.test(ua) && 'Windows') ||
    (/Mac OS X|Macintosh/.test(ua) && 'macOS') ||
    (/CrOS/.test(ua) && 'ChromeOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os;
}

function serialize(row, currentSessionId) {
  return {
    id: row.id,
    app: row.app,
    deviceLabel: row.deviceLabel,
    pushService: row.pushService,
    locale: row.locale,
    enabled: row.enabled,
    current: Boolean(currentSessionId) && row.sessionId === currentSessionId,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

/** The live end of this request's session, or a 401 when it has none. */
async function currentSession(req) {
  const sid = req.authTokenPayload ? req.authTokenPayload.sid : null;
  const sessionId = await sessionGate.currentSessionId(sid);
  if (!sessionId) throw new AuthenticationError('This session has ended. Sign in again.', 'SESSION_ENDED');
  return sessionId;
}

/** GET /me/push/config */
function config() {
  return { enabled: true, publicKey: pushConfig.publicKey() };
}

/**
 * PUT /me/push/subscriptions — this browser, subscribed now. Called again on
 * every visit: it refreshes the keys, the session and last_seen_at, and keeps
 * the device's on/off switch. A browser another account had subscribed passes
 * to this one, switched on afresh: a shared computer stops receiving the first
 * person's notifications.
 */
async function subscribe(user, { app, subscription, locale }, req) {
  if (app === 'console' && !user.platformAdmin) throw new AuthorizationError('Only a console account can subscribe the console');
  const pushService = pushEndpoints.serviceOf(subscription.endpoint);
  if (!pushService) throw new AppError('PUSH_ENDPOINT_NOT_ALLOWED', 'This push service is not supported.', 422);
  const sessionId = await currentSession(req);
  const endpointHash = hashEndpoint(subscription.endpoint);
  const now = new Date();
  const fields = {
    userId: user.id,
    sessionId,
    app,
    endpoint: subscription.endpoint,
    endpointHash,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    pushService,
    deviceLabel: deviceLabel(req.get('user-agent')),
    locale: locale || 'ar',
    lastSeenAt: now,
  };

  // Two tabs subscribing the same new browser at once: the second's insert
  // meets the first's row, and it runs again as an update of that row.
  const save = () => db.sequelize.transaction(async (transaction) => {
    const existing = await db.PushSubscription.findOne({ where: { endpointHash }, transaction, lock: transaction.LOCK.UPDATE });
    let saved;
    if (!existing) {
      saved = await db.PushSubscription.create(fields, { transaction });
    } else if (existing.userId !== user.id) {
      saved = await existing.update({ ...fields, enabled: true, failureCount: 0, lastError: null, lastSuccessAt: null, lastFailureAt: null }, { transaction });
    } else {
      saved = await existing.update(fields, { transaction });
    }
    // One device too many for this account and app: the least recently seen goes.
    const mine = await db.PushSubscription.findAll({
      where: { userId: user.id, app },
      attributes: ['id'],
      order: [
        ['lastSeenAt', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      transaction,
    });
    const over = mine.slice(pushConfig.maxDevicesPerUser()).map((r) => r.id).filter((id) => id !== saved.id);
    if (over.length) await db.PushSubscription.destroy({ where: { id: over }, transaction });
    return saved;
  });
  let row;
  try {
    row = await save();
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    row = await save();
  }
  return { subscription: serialize(row, sessionId) };
}

/** GET /me/push/subscriptions — my devices (never their endpoints or keys). */
async function list(user, { app } = {}, req) {
  const sid = req.authTokenPayload ? req.authTokenPayload.sid : null;
  const sessionId = await sessionGate.currentSessionId(sid);
  const where = { userId: user.id };
  if (app) where.app = app;
  const rows = await db.PushSubscription.findAll({ where, order: [['createdAt', 'ASC']] });
  return { subscriptions: rows.map((r) => serialize(r, sessionId)) };
}

async function mine(user, id) {
  const row = await db.PushSubscription.findOne({ where: { id, userId: user.id } });
  if (!row) throw new NotFoundError('Device');
  return row;
}

/** PATCH /me/push/subscriptions/:id — switched on again, it starts with no failures. */
async function setEnabled(user, id, { enabled }, req) {
  const row = await mine(user, id);
  const patch = { enabled };
  if (enabled) Object.assign(patch, { failureCount: 0, lastError: null });
  await row.update(patch);
  const sid = req.authTokenPayload ? req.authTokenPayload.sid : null;
  return { subscription: serialize(row, await sessionGate.currentSessionId(sid)) };
}

/** DELETE /me/push/subscriptions/:id */
async function remove(user, id) {
  const row = await mine(user, id);
  await row.destroy();
  return { success: true };
}

/**
 * POST /me/push/test — a test notification to one of my devices (`id`), or
 * to every device of this session (the browser asking). Limited per account
 * (pushRoutes).
 */
async function sendTest(user, { id } = {}, req) {
  let targets;
  if (id) {
    targets = [await mine(user, id)];
  } else {
    const sessionId = await currentSession(req);
    targets = await db.PushSubscription.findAll({ where: { userId: user.id, sessionId } });
  }
  if (targets.length === 0) throw new AppError('PUSH_NO_DEVICE', 'This browser has not subscribed to device notifications.', 404);
  const switchedOn = targets.filter((t) => t.enabled);
  if (switchedOn.length === 0) throw new ConflictError('This device is switched off.', 'PUSH_DEVICE_DISABLED');
  const results = [];
  for (const target of switchedOn) {
    const result = await pushSender.send(target, { type: 'push.test', url: TEST_URL[target.app] || '/', tag: 'push.test' }, { ttlSeconds: 5 * 60, urgency: 'normal' });
    results.push({ id: target.id, outcome: result.outcome });
  }
  return { sent: results.filter((r) => r.outcome === 'sent').length, results };
}

/**
 * Daily (notifications/jobs.js): devices whose session has ended (or that a
 * later refresh moved on from) are settled, and devices not seen for 60 days
 * go. Nothing while push is off.
 */
async function cleanup() {
  if (!pushConfig.isOn()) return { skipped: true };
  const settled = await pushSessions.settle();
  const stale = await db.PushSubscription.destroy({ where: { lastSeenAt: { [Op.lt]: new Date(Date.now() - STALE_DAYS * DAY_MS) } } });
  if (settled.removed || stale) logger.info(`Push cleanup: ${settled.removed} devices of ended sessions and ${stale} unseen for ${STALE_DAYS} days removed, ${settled.moved} moved to their current session`);
  return { ...settled, stale };
}

module.exports = { config, subscribe, list, setEnabled, remove, sendTest, cleanup, deviceLabel, hashEndpoint, STALE_DAYS };
