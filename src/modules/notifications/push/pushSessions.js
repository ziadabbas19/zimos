'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../../db/models');
const pushConfig = require('./pushConfig');

/**
 * A device subscription lives as long as the sign-in session it was made under
 * (decision 3 of REPORT-push-notifications.md).
 *
 *  - A refresh replaces the session row (authService.refresh): the device moves
 *    to the new session inside that same transaction (followRotation). Without
 *    this it would stop once the session gate's 50-step chain ran out.
 *  - A session that ends — sign-out, "sign out of all devices", the other
 *    devices after a password or second-step change, a replayed refresh token,
 *    a suspended account — takes its devices with it: hooks on Session, in the
 *    transaction that ends it, whatever service ends it. A session row deleted
 *    takes them by the foreign key.
 *  - What these miss (a session that simply expires, a change made where this
 *    module is not loaded) is caught before every send (pushSender) and by the
 *    daily cleanup (pushService.cleanup), which both follow the refresh chain
 *    the way the session gate does.
 *
 * Nothing at all while push is off (pushConfig.isOn()): a refresh and a
 * sign-out then never touch push_subscriptions.
 */

/** In authService.refresh's transaction, after the new session row is written. */
async function followRotation(fromSessionId, toSessionId, transaction) {
  if (!pushConfig.isOn()) return;
  await db.sequelize.query('UPDATE push_subscriptions SET session_id = :to, updated_at = now() WHERE session_id = :from', {
    replacements: { from: fromSessionId, to: toSessionId },
    transaction,
  });
}

// Devices whose session has ended, not been rotated (a rotated one names its successor).
const ENDED_SQL = (scoped) => `
  DELETE FROM push_subscriptions ps USING sessions s
   WHERE ps.session_id = s.id AND s.revoked_at IS NOT NULL AND s.rotated_to_session_id IS NULL
   ${scoped ? 'AND s.user_id IN (:userIds)' : ''}`;

async function dropEnded(userIds, transaction) {
  if (!pushConfig.isOn()) return;
  const scoped = Array.isArray(userIds) && userIds.length > 0;
  await db.sequelize.query(ENDED_SQL(scoped), { replacements: scoped ? { userIds } : {}, transaction });
}

/** The account ids a bulk change's `where` names (a string or an array), or null. */
function userIdsFrom(where) {
  const value = where ? where.userId : undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value;
  return null;
}

const setsAny = (options, fields) => Boolean(options && options.attributes) && fields.some((field) => Object.prototype.hasOwnProperty.call(options.attributes, field));

let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const NAME = 'pushSessions';
  db.Session.addHook('afterUpdate', NAME, (session, options) => {
    if (session.changed('revokedAt') && session.revokedAt && !session.rotatedToSessionId) {
      return dropEnded([session.userId], options && options.transaction);
    }
    return undefined;
  });
  db.Session.addHook('afterBulkUpdate', NAME, (options) => {
    if (setsAny(options, ['revokedAt']) && !setsAny(options, ['rotatedToSessionId'])) {
      return dropEnded(userIdsFrom(options.where), options.transaction);
    }
    return undefined;
  });
}

install();

// The live end of each device's refresh chain, as sessionGate's CHAIN_SQL
// reads it for one session (50 steps at most).
const CHAIN_ENDS_SQL = `
  WITH RECURSIVE chain AS (
    SELECT ps.id AS sub_id, ps.session_id AS bound, s.id, s.revoked_at, s.expires_at, s.rotated_to_session_id, 1 AS depth
      FROM push_subscriptions ps JOIN sessions s ON s.id = ps.session_id
     WHERE (:subId::uuid IS NULL OR ps.id = :subId::uuid)
    UNION ALL
    SELECT c.sub_id, c.bound, s.id, s.revoked_at, s.expires_at, s.rotated_to_session_id, c.depth + 1
      FROM chain c JOIN sessions s ON s.id = c.rotated_to_session_id
     WHERE c.revoked_at IS NOT NULL AND c.depth < 50
  )
  SELECT DISTINCT ON (sub_id) sub_id AS "subId", bound, id AS "sessionId", (revoked_at IS NULL AND expires_at > now()) AS active
    FROM chain ORDER BY sub_id, depth DESC`;

/**
 * Follows every device's session (or one device's) to its live end: a device
 * whose chain has ended is deleted, one left on an older link of a live chain
 * is moved to its end. Returns { removed, moved }.
 */
async function settle(subId = null) {
  const ends = await db.sequelize.query(CHAIN_ENDS_SQL, { replacements: { subId }, type: QueryTypes.SELECT });
  const dead = ends.filter((e) => !e.active).map((e) => e.subId);
  let removed = 0;
  if (dead.length) removed = await db.PushSubscription.destroy({ where: { id: dead } });
  let moved = 0;
  for (const end of ends.filter((e) => e.active && e.sessionId !== e.bound)) {
    const [count] = await db.PushSubscription.update({ sessionId: end.sessionId }, { where: { id: end.subId, sessionId: end.bound } });
    moved += count;
  }
  return { removed, moved };
}

module.exports = { followRotation, dropEnded, settle, userIdsFrom, install };
