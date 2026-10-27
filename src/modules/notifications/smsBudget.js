'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * The daily SMS caps: the most SMS the platform pays for in one UTC day,
 * overall (SMS_PLATFORM_DAILY_CAP) and for one store (SMS_STORE_DAILY_CAP).
 *
 * notify.sms takes a slot before it calls the provider. A slot is one
 * statement on sms_daily_usage (migration 723) that adds 1 only while the
 * count is under the cap, so concurrent sends and every API instance share
 * one count. A store's SMS takes a store slot, then the platform slot; the
 * platform's own SMS (phone verification, sign-up and sign-in codes) only
 * the platform slot. Every send attempted counts, delivered or not.
 *
 * Past a cap the SMS is not sent: the caller sees a failed send, the row
 * counts it as refused, and the console is told once a day per scope
 * (platform notification "sms_cap"). Both caps unset: nothing is read or
 * written. A count that cannot be written lets the SMS go (logged): the caps
 * bound a cost, they must not stop every code when the database hiccups.
 */

const PLATFORM = 'platform';
const utcDay = (at = new Date()) => at.toISOString().slice(0, 10);
const storeKey = (workspaceId) => `store:${workspaceId}`;

/** Adds one to the scope's count when it is under `cap`; false when the cap is reached. */
async function take(day, scopeKey, workspaceId, cap) {
  const [rows] = await db.sequelize.query(
    `INSERT INTO sms_daily_usage (day, scope_key, workspace_id, sent, refused, updated_at)
     VALUES (:day, :scopeKey, :workspaceId, 1, 0, now())
     ON CONFLICT (day, scope_key) DO UPDATE SET sent = sms_daily_usage.sent + 1, updated_at = now()
       WHERE sms_daily_usage.sent < :cap
     RETURNING sent`,
    { replacements: { day, scopeKey, workspaceId, cap } }
  );
  return rows.length > 0;
}

/** Gives back a store slot taken for an SMS the platform cap then refused. */
async function release(day, scopeKey) {
  await db.sequelize.query(
    'UPDATE sms_daily_usage SET sent = sent - 1, updated_at = now() WHERE day = :day AND scope_key = :scopeKey AND sent > 0',
    { replacements: { day, scopeKey } }
  );
}

async function capReached({ day, scopeKey, workspaceId, cap }) {
  const scope = workspaceId ? 'store' : 'platform';
  logger.warn('[notification:sms] daily SMS cap reached; this SMS is not sent', { scope, workspaceId, cap, day });
  await db.sequelize.query(
    `UPDATE sms_daily_usage SET refused = refused + 1, cap_reached_at = coalesce(cap_reached_at, now()), updated_at = now()
      WHERE day = :day AND scope_key = :scopeKey`,
    { replacements: { day, scopeKey } }
  );
  let name = null;
  if (workspaceId) {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name'] });
    name = workspace ? workspace.name : null;
  }
  // Never throws; the database keeps one per scope and day.
  await require('../platformAdmin/platformNotificationService').notify({
    type: 'sms_cap',
    title: workspaceId ? 'Store reached its daily SMS cap' : 'Platform reached its daily SMS cap',
    body: workspaceId
      ? `${name || workspaceId} was sent ${cap} SMS on ${day} (UTC, SMS_STORE_DAILY_CAP); its other SMS that day are not sent.`
      : `${cap} SMS were sent on ${day} (UTC, SMS_PLATFORM_DAILY_CAP); no other SMS is sent that day.`,
    link: workspaceId ? `/workspaces/${workspaceId}` : null,
    workspaceId,
    data: { scope, day, cap },
    dedupeKey: `sms_cap:${scopeKey}:${day}`,
  });
}

/**
 * Takes the slots an SMS needs: `{ ok: true }`, or `{ ok: false, error }`
 * when a cap is reached (nothing is then sent). `workspaceId`: the store the
 * SMS is sent for, null for the platform's own.
 */
async function reserve({ workspaceId = null } = {}) {
  const platformCap = env.sms.platformDailyCap;
  const storeCap = workspaceId ? env.sms.storeDailyCap : 0;
  if (!platformCap && !storeCap) return { ok: true };
  const day = utcDay();
  try {
    if (storeCap && !(await take(day, storeKey(workspaceId), workspaceId, storeCap))) {
      await capReached({ day, scopeKey: storeKey(workspaceId), workspaceId, cap: storeCap });
      return { ok: false, error: 'SMS_STORE_DAILY_CAP reached for this store today' };
    }
    if (platformCap && !(await take(day, PLATFORM, null, platformCap))) {
      if (storeCap) await release(day, storeKey(workspaceId));
      await capReached({ day, scopeKey: PLATFORM, workspaceId: null, cap: platformCap });
      return { ok: false, error: 'SMS_PLATFORM_DAILY_CAP reached today' };
    }
    return { ok: true };
  } catch (err) {
    logger.error(`[notification:sms] the daily SMS count could not be written; the SMS goes: ${err.message}`);
    return { ok: true };
  }
}

module.exports = { reserve, utcDay };
