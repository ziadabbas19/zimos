'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const queue = require('../../core/queue');
const pushConfig = require('../notifications/push/pushConfig');
const pushSender = require('../notifications/push/pushSender');
const notifications = require('./platformNotificationService');
const { isCreator } = require('../../core/security/platformPermissions');

/**
 * Device notifications for the console (migration 745): every row the console's
 * bell gets (platformNotificationService.notify, and the hourly sweep) is also
 * sent to the devices of the accounts the bell shows it to. Nothing while push
 * is off (PUSH_ENABLED and a VAPID pair, notifications/push/pushConfig).
 *
 * The row's write queues one job (`console_push.send`) in the writer's
 * transaction, so a change that rolls back sends nothing. The job, at the send:
 *
 *  - Who: a console account, active, with a console device switched on, that
 *    the bell shows the row to: the type's permission (visibleTypes), the
 *    row's own recipients and hidden ones (a creator aside), and neither "in
 *    the console" nor "on my devices" turned off for the type. Not whoever made
 *    it happen (actor_user_id): nobody is told about their own action.
 *  - Once: each account is marked in platform_notification_pushes with the
 *    row's created_at in the same statement that picks them, so two jobs for
 *    the same row cannot both send. A review that changes again moves the
 *    row's created_at on (the bell shows it as new and unread), and that alone
 *    sends it again.
 *  - What: a sentence per type from pushPayload's allowlist ("console.*"), in
 *    each device's language, and the row's console link. No merchant's name,
 *    email or phone, and no reason a reviewer typed.
 *
 * A device the push service no longer knows (404, 410) is deleted by
 * pushSender; one it asks to come back to is sent again by push.resend.
 * Nothing here ever throws to its caller.
 */

const JOB = 'console_push.send';
const SENT_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_SECONDS = 12 * 60 * 60;

const asDate = (value) => (value instanceof Date ? value : new Date(value));

/**
 * Queues the push of a row notify() just wrote (`{ id, createdAt }`); with the
 * writer's transaction it is queued only if that commits. Never throws.
 */
async function queueFor(row, transaction = null) {
  if (!row || !row.id || !pushConfig.isOn()) return;
  try {
    const at = asDate(row.createdAt).getTime();
    await queue.add('notifications', JOB, { notificationId: row.id }, { transaction, dedupeKey: `${JOB}:${row.id}:${at}` });
  } catch (err) {
    logger.error(`[console-push] could not queue notification ${row.id}: ${err.message}`);
  }
}

/** The push text's type: the bell's own, or the decision's for a decided review. */
function pushTypeOf(row) {
  const data = row.data || {};
  const decision = data.decision === 'rejected' ? 'rejected' : 'approved';
  if (row.type === 'referral_code_decided') return `console.referral_${data.change === 'change' ? 'change' : 'code'}_${decision}`;
  if (row.type === 'agent_link_decided') return `console.agent_link_${decision}`;
  return `console.${row.type}`;
}

/**
 * Of `accounts` (console accounts with a device), the ids the bell shows `row`
 * to with push on for its type. `prefs`: Map of userId → { enabled, push } as
 * saved (none saved: the defaults, both on).
 */
function recipientsOf(row, accounts, prefs = new Map()) {
  const recipients = Array.isArray(row.recipientUserIds) ? row.recipientUserIds : null;
  const hidden = Array.isArray(row.hiddenFromUserIds) ? row.hiddenFromUserIds : null;
  return accounts
    .filter((user) => {
      if (row.actorUserId && user.id === row.actorUserId) return false;
      if (!notifications.visibleTypes(user).includes(row.type)) return false;
      if (recipients && !recipients.includes(user.id)) return false;
      if (hidden && hidden.includes(user.id) && !isCreator(user)) return false;
      const pref = prefs.get(user.id);
      if (pref && (pref.enabled === false || pref.push === false)) return false;
      return true;
    })
    .map((user) => user.id);
}

/** Of `userIds`, those this version of the row has not reached yet; they are marked as reached in the same statement. */
async function claim(row, userIds) {
  if (userIds.length === 0) return [];
  const rows = await db.sequelize.query(
    `INSERT INTO platform_notification_pushes (notification_id, user_id, event_at, created_at)
     SELECT :id, u, CAST(:eventAt AS TIMESTAMPTZ), now() FROM unnest(ARRAY[:userIds]::uuid[]) AS u
     ON CONFLICT (notification_id, user_id) DO UPDATE SET event_at = EXCLUDED.event_at, created_at = now()
       WHERE platform_notification_pushes.event_at < EXCLUDED.event_at
     RETURNING user_id AS "userId"`,
    { replacements: { id: row.id, eventAt: row.eventAt, userIds }, type: QueryTypes.SELECT }
  );
  return rows.map((r) => r.userId);
}

async function loadRow(notificationId) {
  const [row] = await db.sequelize.query(
    `SELECT id, type, link, data, actor_user_id AS "actorUserId", recipient_user_ids AS "recipientUserIds",
            hidden_from_user_ids AS "hiddenFromUserIds",
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "eventAt"
       FROM platform_notifications WHERE id = :id`,
    { replacements: { id: notificationId }, type: QueryTypes.SELECT }
  );
  return row || null;
}

/** userId → { enabled, push } for `type`, only for accounts that saved a choice. */
async function prefsFor(type, userIds) {
  if (userIds.length === 0) return new Map();
  const rows = await db.sequelize.query('SELECT user_id AS "userId", enabled, push FROM platform_notification_prefs WHERE type = :type AND user_id IN (:userIds)', {
    replacements: { type, userIds },
    type: QueryTypes.SELECT,
  });
  return new Map(rows.map((r) => [r.userId, r]));
}

/**
 * Sends one row to the devices of the accounts its bell shows it to (the
 * `console_push.send` job). Returns what happened. Never throws.
 */
async function send(notificationId) {
  try {
    if (!pushConfig.isOn()) return { sent: 0, skipped: 'off' };
    const row = await loadRow(notificationId);
    // Withdrawn before its turn: what it said no longer holds.
    if (!row) return { sent: 0, skipped: 'gone' };

    const devices = await db.PushSubscription.findAll({ where: { app: 'console', enabled: true } });
    const deviceOwners = [...new Set(devices.map((device) => device.userId))];
    if (deviceOwners.length === 0) return { sent: 0, skipped: 'no_device' };
    const accounts = await db.User.findAll({
      where: { id: deviceOwners, platformRole: { [Op.ne]: null }, status: 'active', deletedAt: null },
      attributes: ['id', 'platformRole', 'platformPermissions', 'status'],
    });
    const chosen = recipientsOf(row, accounts, await prefsFor(row.type, accounts.map((user) => user.id)));
    const reached = await claim(row, chosen);
    if (reached.length === 0) return { sent: 0, recipients: 0 };

    const byId = new Map(accounts.map((user) => [user.id, user]));
    const type = pushTypeOf(row);
    const params = { code: row.data && row.data.code };
    let sent = 0;
    for (const device of devices) {
      if (!reached.includes(device.userId)) continue;
      const user = byId.get(device.userId);
      const message = { type, params, url: notifications.linkFor(row, user) || '/notifications', tag: `console:${row.id}`, count: 1 };
      const options = { ttlSeconds: TTL_SECONDS, urgency: 'normal' };
      const result = await pushSender.send(device, message, options);
      if (result.outcome === 'sent') sent += 1;
      else if (result.outcome === 'retry') {
        await queue.add(
          'notifications',
          'push.resend',
          { subscriptionId: device.id, message, options, attempt: 2 },
          { delayMs: Math.min(result.retryAfterMs || 60 * 1000, 10 * 60 * 1000) }
        );
      }
    }
    return { sent, recipients: reached.length };
  } catch (err) {
    logger.error(`[console-push] could not send notification ${notificationId}: ${err.message}`);
    return { sent: 0, error: err.message };
  }
}

/** Daily: what reached whom, older than 3 days, is forgotten; a row is only sent from the job its write queued. Nothing while off. */
async function forgetSent() {
  if (!pushConfig.isOn()) return { skipped: true };
  const [, result] = await db.sequelize.query('DELETE FROM platform_notification_pushes WHERE created_at < :before', {
    replacements: { before: new Date(Date.now() - SENT_DAYS * DAY_MS) },
  });
  return { removed: result && typeof result.rowCount === 'number' ? result.rowCount : 0 };
}

module.exports = { JOB, queueFor, send, forgetSent, recipientsOf, pushTypeOf, claim };
