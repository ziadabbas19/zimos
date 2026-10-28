'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const queue = require('../../../core/queue');
const pushConfig = require('./pushConfig');
const pushSender = require('./pushSender');

/**
 * Device notifications for the merchant's teammates, gathered and sent
 * (decision 7 of REPORT-push-notifications.md).
 *
 * merchantNotificationService.create() records one for each teammate whose
 * `push` channel is on for the type and who has a device (record). The first
 * of a kind opens a row in push_digests and queues its send for the end of the
 * window; the ones that come before then only count. The send (flush) deletes
 * the row and sends one notification: the order's number and amount when it
 * is one, "5 new orders" when it is more.
 *
 * At the send, again: push still on, the teammate still in the store with the
 * permission and the channel, the devices still there (pushSender checks the
 * session and the endpoint, and deletes a device the push service no longer
 * knows). What reaches a device is built by pushPayload from an allowlist:
 * the store's name, an order's number and amount, a count. Never a customer's
 * name, phone, address or message, a locked order's included (its number and
 * amounts are not what the lock hides: orders/orderLock.js).
 *
 * Nothing here ever throws to its caller: a notification, an order or a
 * payment never fails because of a device.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Per type: how long a window gathers, which ids of the latest one are kept
 * (`refs`, nothing else is), where it opens one and many, and how it is sent.
 * `group` splits a type into windows of their own (a WhatsApp conversation).
 */
const ORDER_KIND = {
  windowMs: 20 * SECOND,
  refs: ['orderId'],
  one: (refs) => (refs.orderId ? `/orders/${refs.orderId}` : '/orders'),
  many: () => '/orders',
  ttlSeconds: HOUR / SECOND,
};
const KINDS = {
  'order.new': { ...ORDER_KIND, urgency: 'high', topic: 'ordnew' },
  'order.paid': { ...ORDER_KIND, urgency: 'normal', topic: 'ordpaid' },
  'order.suspicious': { ...ORDER_KIND, urgency: 'normal', topic: 'ordrisk' },
  'lost_order.new': { windowMs: HOUR, refs: [], one: () => '/abandoned-carts', many: () => '/abandoned-carts', ttlSeconds: 6 * HOUR / SECOND, urgency: 'normal', topic: 'lost' },
  'whatsapp.message': {
    windowMs: 5 * MINUTE,
    refs: ['conversationId'],
    group: (refs) => refs.conversationId || null,
    one: () => '/inbox',
    many: () => '/inbox',
    ttlSeconds: HOUR / SECOND,
    urgency: 'high',
    topic: 'wa',
  },
  'stock.low': { windowMs: 20 * SECOND, refs: ['productId'], one: (refs) => (refs.productId ? `/catalog/${refs.productId}` : '/catalog'), many: () => '/catalog' },
};
const DEFAULT_KIND = { windowMs: 20 * SECOND, refs: [], ttlSeconds: 12 * HOUR / SECOND, urgency: 'normal' };

const kindOf = (type) => ({ ...DEFAULT_KIND, ...(KINDS[type] || {}) });

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** The ids `type` keeps from what create() was given (`data`), and nothing else. */
function refsOf(type, data) {
  const out = {};
  for (const key of kindOf(type).refs) {
    const value = data && data[key];
    if (typeof value === 'string' && ID.test(value)) out[key] = value;
  }
  return out;
}

const groupKeyOf = (type, refs) => {
  const group = kindOf(type).group ? kindOf(type).group(refs) : null;
  return group ? `${type}:${group}` : type;
};

/** The teammates among `userIds` with a dashboard device switched on. */
async function withDevices(userIds) {
  if (userIds.length === 0) return new Set();
  const rows = await db.PushSubscription.findAll({ where: { userId: userIds, app: 'dashboard', enabled: true }, attributes: ['userId'] });
  return new Set(rows.map((row) => row.userId));
}

const UPSERT_SQL = `
  INSERT INTO push_digests (id, workspace_id, user_id, type, group_key, count, refs, first_at, last_at, flush_at, created_at, updated_at)
  VALUES (:id, :workspaceId, :userId, :type, :groupKey, 1, CAST(:refs AS jsonb), now(), now(), now() + (:windowMs * INTERVAL '1 millisecond'), now(), now())
  ON CONFLICT (workspace_id, user_id, group_key)
  DO UPDATE SET count = push_digests.count + 1, refs = EXCLUDED.refs, last_at = now(), updated_at = now()
  RETURNING id, (xmax = 0) AS opened`;

/**
 * One notification of `type` for each of `userIds` (create() has already
 * applied permission, preference and the dedupe key). Teammates without a
 * device are skipped. Never throws.
 */
async function record(workspaceId, type, userIds, data) {
  try {
    if (!pushConfig.isOn() || userIds.length === 0) return 0;
    const devices = await withDevices(userIds);
    const kind = kindOf(type);
    const refs = refsOf(type, data);
    const groupKey = groupKeyOf(type, refs);
    let recorded = 0;
    for (const userId of userIds.filter((id) => devices.has(id))) {
      const [row] = await db.sequelize.query(UPSERT_SQL, {
        replacements: { id: crypto.randomUUID(), workspaceId, userId, type, groupKey, refs: JSON.stringify(refs), windowMs: kind.windowMs },
        type: QueryTypes.SELECT,
      });
      recorded += 1;
      if (row && row.opened) {
        await queue.add('notifications', 'push.flush', { digestId: row.id }, { delayMs: kind.windowMs, dedupeKey: `push.flush:${row.id}`, workspaceId });
      }
    }
    return recorded;
  } catch (err) {
    logger.error(`[push] could not record ${type} for workspace ${workspaceId}: ${err.message}`);
    return 0;
  }
}

/** The order's number and amount for a one-order text, read now; never its customer. */
async function orderParams(workspaceId, orderId) {
  if (!orderId) return {};
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'orderNumber', 'totalAmount', 'currency'] });
  return order ? { orderNumber: order.orderNumber, amount: { minor: order.totalAmount, currency: order.currency } } : {};
}

const withStore = (path, workspaceId) => `${path}${path.includes('?') ? '&' : '?'}workspace=${workspaceId}`;

/**
 * Sends a digest the window closed on (the push.flush job, or the overdue
 * sweep). Returns what happened per device. Never throws.
 */
async function flush(digestId) {
  try {
    const [rows] = await db.sequelize.query(
      'DELETE FROM push_digests WHERE id = :id RETURNING workspace_id AS "workspaceId", user_id AS "userId", type, group_key AS "groupKey", count, refs',
      { replacements: { id: digestId } }
    );
    const digest = rows && rows[0];
    if (!digest || !pushConfig.isOn()) return { sent: 0, skipped: !digest ? 'gone' : 'off' };

    // eslint-disable-next-line global-require
    const notifications = require('../merchantNotificationService');
    if (!(await notifications.pushAllowed(digest.workspaceId, digest.userId, digest.type))) return { sent: 0, skipped: 'not_allowed' };

    const devices = await db.PushSubscription.findAll({ where: { userId: digest.userId, app: 'dashboard', enabled: true } });
    if (devices.length === 0) return { sent: 0, skipped: 'no_device' };

    const kind = kindOf(digest.type);
    const refs = digest.refs || {};
    const count = Number(digest.count) || 1;
    const workspace = await db.Workspace.findByPk(digest.workspaceId, { attributes: ['id', 'name'] });
    const params = { storeName: workspace ? workspace.name : null, ...(count === 1 && refs.orderId ? await orderParams(digest.workspaceId, refs.orderId) : {}) };
    const path = count === 1 && kind.one ? kind.one(refs) : kind.many ? kind.many(refs) : '/';
    const message = {
      type: digest.type,
      params,
      url: withStore(path, digest.workspaceId),
      tag: `${digest.type}:${refs.conversationId || digest.workspaceId}`.slice(0, 64),
      count,
    };
    const options = {
      ttlSeconds: kind.ttlSeconds,
      urgency: kind.urgency,
      topic: kind.topic ? `${kind.topic}-${String(refs.conversationId || digest.workspaceId).slice(0, 8)}` : undefined,
    };

    let sent = 0;
    for (const device of devices) {
      const result = await pushSender.send(device, message, options);
      if (result.outcome === 'sent') sent += 1;
      else if (result.outcome === 'retry') {
        await queue.add(
          'notifications',
          'push.resend',
          { subscriptionId: device.id, message, options, attempt: 2 },
          { delayMs: Math.min(result.retryAfterMs || MINUTE, 10 * MINUTE), workspaceId: digest.workspaceId }
        );
      }
    }
    return { sent, devices: devices.length };
  } catch (err) {
    logger.error(`[push] could not send digest ${digestId}: ${err.message}`);
    return { sent: 0, error: err.message };
  }
}

const MAX_ATTEMPTS = 3;

/** One device the push service asked to come back to (429, 5xx): tried again, three times at most. */
async function resend({ subscriptionId, message, options, attempt = 2 }) {
  try {
    if (!pushConfig.isOn()) return { outcome: 'off' };
    const device = await db.PushSubscription.findByPk(subscriptionId);
    if (!device) return { outcome: 'gone' };
    const result = await pushSender.send(device, message, options);
    if (result.outcome === 'retry' && attempt < MAX_ATTEMPTS) {
      await queue.add(
        'notifications',
        'push.resend',
        { subscriptionId, message, options, attempt: attempt + 1 },
        { delayMs: Math.min(result.retryAfterMs || MINUTE * attempt, 10 * MINUTE) }
      );
    }
    return result;
  } catch (err) {
    logger.error(`[push] could not send again to device ${subscriptionId}: ${err.message}`);
    return { outcome: 'failed' };
  }
}

/** Every few minutes: digests whose queued send was lost are sent now. Nothing while push is off. */
async function flushOverdue() {
  if (!pushConfig.isOn()) return { skipped: true };
  const due = await db.PushDigest.findAll({ where: { flushAt: { [db.Sequelize.Op.lt]: new Date(Date.now() - 2 * MINUTE) } }, attributes: ['id'], limit: 200 });
  for (const digest of due) await flush(digest.id);
  return { flushed: due.length };
}

module.exports = { record, flush, resend, flushOverdue, refsOf, groupKeyOf, kindOf, KINDS };
