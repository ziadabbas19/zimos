'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const publisher = require('./publisher');

/**
 * Ends an account's live updates the moment its access changes, on every
 * server, instead of at the next periodic check (realtimeServer: sessions every
 * 15 s, rooms every 60 s, which stay as a safety net).
 *
 * Hooks on the models themselves, so every path is covered whatever service
 * makes the change: a teammate removed, given another role or suspended in a
 * store (Membership), a session ended by sign-out, "sign out everywhere", a
 * password reset or a reused refresh token (Session), an account suspended,
 * deleted or given other console permissions (User), a role's permissions
 * edited (Role).
 *
 * After the change commits, every server hears of it (publisher.js):
 *  - access changed (membership, account, role): the account's sockets are
 *    closed (publisher.cutAccess). The client connects again, and its new
 *    handshake works the rooms out from the database as they now are, or is
 *    refused.
 *  - a session ended: only the account's sockets whose session has ended are
 *    closed (publisher.checkSessionsOf), so signing out on the phone leaves the
 *    laptop connected.
 * When a bulk change does not say which accounts it touched, every server
 * checks all its sockets now instead (publisher.resyncAll).
 *
 * In the usual case that is all within a moment of the commit. It falls back
 * to the periodic checks when the message cannot be sent (tried twice, 2 s
 * apart) or a server's LISTEN is down at that moment, and for changes made
 * where this module is not loaded (a script run from the command line).
 *
 * Left alone: the rotation a refresh makes (the old session names its
 * successor and the access goes on), and every other column (a pinned
 * shortcut, a last-seen time). Nothing at all while REALTIME_ENABLED is off.
 */

const MEMBERSHIP_FIELDS = ['roleId', 'status'];
const USER_FIELDS = ['status', 'deletedAt', 'platformRole', 'platformPermissions'];
const ROLE_FIELDS = ['permissions'];

function afterCommit(options, fn) {
  const transaction = options && options.transaction;
  if (transaction) transaction.afterCommit(() => void fn());
  else void fn();
}

/** The ids a bulk change's `where` names for `key`, or null when it names none. */
function idsFrom(where, key) {
  const value = where ? where[key] : undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (value && typeof value === 'object' && Array.isArray(value[Op.in])) return value[Op.in].filter((v) => typeof v === 'string');
  if (value && typeof value === 'object' && typeof value[Op.eq] === 'string') return [value[Op.eq]];
  return null;
}

const changedAny = (instance, fields) => fields.some((field) => instance.changed(field));
const setsAny = (options, fields) => Boolean(options && options.attributes) && fields.some((field) => Object.prototype.hasOwnProperty.call(options.attributes, field));

/** After the commit, for each account: `send(userId)` (publisher.cutAccess or checkSessionsOf). */
function tell(send, userIds, options) {
  if (!env.realtime.enabled) return;
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;
  afterCommit(options, () => Promise.all(ids.map((id) => send(id))));
}

const cut = (userIds, options) => tell((id) => publisher.cutAccess(id), userIds, options);
const checkSessions = (userIds, options) => tell((id) => publisher.checkSessionsOf(id), userIds, options);

function resync(options) {
  if (!env.realtime.enabled) return;
  afterCommit(options, () => publisher.resyncAll());
}

/** A bulk change: `act` on the accounts its `where` names, or every server checks everything. */
function bulk(options, key, act) {
  const ids = idsFrom(options && options.where, key);
  if (ids) act(ids, options);
  else resync(options);
}

let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const NAME = 'realtimeControl';

  db.Membership.addHook('afterUpdate', NAME, (membership, options) => {
    if (changedAny(membership, MEMBERSHIP_FIELDS)) cut([membership.userId], options);
  });
  db.Membership.addHook('afterDestroy', NAME, (membership, options) => cut([membership.userId], options));
  db.Membership.addHook('afterBulkUpdate', NAME, (options) => {
    if (setsAny(options, MEMBERSHIP_FIELDS)) bulk(options, 'userId', cut);
  });
  db.Membership.addHook('afterBulkDestroy', NAME, (options) => bulk(options, 'userId', cut));

  // A session that ends, not one a refresh rotated (that one names its successor).
  db.Session.addHook('afterUpdate', NAME, (session, options) => {
    if (session.changed('revokedAt') && session.revokedAt && !session.rotatedToSessionId) checkSessions([session.userId], options);
  });
  db.Session.addHook('afterBulkUpdate', NAME, (options) => {
    if (setsAny(options, ['revokedAt']) && !setsAny(options, ['rotatedToSessionId'])) bulk(options, 'userId', checkSessions);
  });
  db.Session.addHook('afterDestroy', NAME, (session, options) => checkSessions([session.userId], options));
  db.Session.addHook('afterBulkDestroy', NAME, (options) => bulk(options, 'userId', checkSessions));

  db.User.addHook('afterUpdate', NAME, (user, options) => {
    if (changedAny(user, USER_FIELDS)) cut([user.id], options);
  });
  db.User.addHook('afterBulkUpdate', NAME, (options) => {
    if (setsAny(options, USER_FIELDS)) bulk(options, 'id', cut);
  });
  db.User.addHook('afterDestroy', NAME, (user, options) => cut([user.id], options));

  db.Role.addHook('afterUpdate', NAME, (role, options) => {
    if (changedAny(role, ROLE_FIELDS)) resync(options);
  });
  db.Role.addHook('afterBulkUpdate', NAME, (options) => {
    if (setsAny(options, ROLE_FIELDS)) resync(options);
  });
  db.Role.addHook('afterDestroy', NAME, (role, options) => resync(options));
}

install();

module.exports = { install, idsFrom };
