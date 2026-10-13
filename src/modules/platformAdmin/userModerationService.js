'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, AuthorizationError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { PLATFORM_ROLES, PLATFORM_PERMISSIONS, hasPlatformPermission } = require('../../core/security/platformPermissions');

/**
 * Suspending and deleting an account from the console (workspaces.manage).
 *
 *   - suspend: status 'suspended' with when and why, every session revoked.
 *     Sign-in (password and Google) answers ACCOUNT_SUSPENDED; a token
 *     already issued is refused by authenticate (status not active).
 *   - unsuspend: back to 'active'. A deleted account stays deleted.
 *   - delete: soft. The row stays so stores, orders and audit rows keep their
 *     foreign keys; email, phone, name and username are anonymised, the
 *     password removed, sessions revoked, status 'suspended' and deleted_at
 *     set. The Google id is kept so that Google account is refused
 *     (ACCOUNT_DELETED) instead of silently getting a new account. An
 *     account that owns stores is deleted only with `stores: 'suspend'`, and
 *     those stores are suspended in the same transaction.
 *
 * Nobody acts on themselves; a creator's account needs a creator; another
 * console account needs admins.manage; the last creator is never suspended
 * or deleted. The actor's own permission is read again under the lock. Every write is audited as a
 * platform-level entry.
 */

function view(user) {
  return {
    id: user.id,
    status: user.status,
    suspendedAt: user.suspendedAt,
    suspendedReason: user.suspendedReason,
    deletedAt: user.deletedAt,
  };
}

/**
 * Locks the target account (and the creators and the actor, in id order) for
 * an action from the console. `permission` is the one the action needs: the
 * actor's own account is read again under the lock, so a permission taken
 * away a moment ago no longer counts.
 */
async function lockTarget(rawUserId, req, transaction, { permission = PLATFORM_PERMISSIONS.WORKSPACES_MANAGE } = {}) {
  // Postgres matches a uuid in any case; compare the canonical form.
  const userId = String(rawUserId).toLowerCase();
  if (userId === req.user.id) {
    throw new ConflictError('You cannot do this to your own account.', 'CANNOT_ACT_ON_SELF');
  }
  const rows = await db.User.findAll({
    where: { [Op.or]: [{ platformRole: PLATFORM_ROLES.CREATOR }, { id: [userId, req.user.id] }] },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const actor = rows.find((u) => u.id === req.user.id);
  if (!actor || actor.status !== 'active' || actor.deletedAt || !hasPlatformPermission(actor, permission)) {
    throw new AuthorizationError();
  }
  const target = rows.find((u) => u.id === userId);
  if (!target) throw new NotFoundError('User');
  if (target.platformRole === PLATFORM_ROLES.CREATOR) {
    if (actor.platformRole !== PLATFORM_ROLES.CREATOR) {
      throw new AppError('CREATOR_REQUIRED', "Only a creator can act on a creator's account.", 403);
    }
    const others = rows.filter((u) => u.platformRole === PLATFORM_ROLES.CREATOR && u.status === 'active' && u.id !== target.id);
    if (others.length < 1) throw new ConflictError('This is the last creator.', 'LAST_CREATOR');
  } else if (target.platformRole && !hasPlatformPermission(actor, PLATFORM_PERMISSIONS.ADMINS_MANAGE)) {
    throw new AppError('ADMINS_MANAGE_REQUIRED', 'Only an admin who manages platform users can act on a console account.', 403);
  }
  return target;
}

async function revokeSessions(userId, transaction) {
  const now = new Date();
  const [revoked] = await db.Session.update({ revokedAt: now }, { where: { userId, revokedAt: null }, transaction });
  // A sign-in that passed the password and waits for its second step ends too.
  await db.LoginChallenge.update({ consumedAt: now }, { where: { userId, consumedAt: null }, transaction });
  // So do the links already in the account's inbox: an email-verification or
  // password-reset link from before must not act on the account afterwards.
  await db.VerificationToken.update({ usedAt: now }, { where: { userId, usedAt: null }, transaction });
  return revoked;
}

async function suspend(userId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const user = await lockTarget(userId, req, transaction);
    if (user.deletedAt) throw new ConflictError('This account was deleted.', 'USER_DELETED');
    if (user.status === 'suspended') throw new ConflictError('This account is already suspended.', 'USER_ALREADY_SUSPENDED');
    const before = user.status;
    await user.update({ status: 'suspended', suspendedAt: new Date(), suspendedReason: reason }, { transaction });
    const sessionsRevoked = await revokeSessions(user.id, transaction);
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.suspend',
      entityType: 'User',
      entityId: user.id,
      before: { status: before },
      after: { status: 'suspended' },
      metadata: { reason, sessionsRevoked },
      req,
      transaction,
    });
    return view(user);
  });
}

async function unsuspend(userId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const user = await lockTarget(userId, req, transaction);
    if (user.deletedAt) throw new ConflictError('This account was deleted.', 'USER_DELETED');
    if (user.status !== 'suspended') throw new ConflictError('This account is not suspended.', 'USER_NOT_SUSPENDED');
    const suspendedFor = user.suspendedReason;
    await user.update({ status: 'active', suspendedAt: null, suspendedReason: null }, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.unsuspend',
      entityType: 'User',
      entityId: user.id,
      before: { status: 'suspended' },
      after: { status: 'active' },
      metadata: { reason: reason || null, suspensionReason: suspendedFor },
      req,
      transaction,
    });
    return view(user);
  });
}

async function remove(userId, { reason, stores }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const user = await lockTarget(userId, req, transaction);
    if (user.deletedAt) throw new ConflictError('This account was already deleted.', 'USER_DELETED');

    const owned = await db.Workspace.findAll({
      where: { ownerUserId: user.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (owned.length > 0 && stores !== 'suspend') {
      throw new AppError('OWNS_STORES', 'This account owns stores. Choose to suspend them to delete it.', 409, [
        { field: 'stores', message: `Owns ${owned.length} store(s)` },
      ]);
    }
    const now = new Date();
    const suspendedStores = [];
    for (const workspace of owned) {
      if (workspace.status !== 'active') continue;
      await workspace.update(
        { status: 'suspended', suspendedAt: now, suspendedByUserId: req.user.id, suspensionReason: reason || 'Owner account deleted' },
        { transaction }
      );
      suspendedStores.push(workspace.id);
      await recordAudit({
        actorUserId: req.user.id,
        action: 'workspace.suspend',
        entityType: 'Workspace',
        entityId: workspace.id,
        before: { status: 'active' },
        after: { status: 'suspended' },
        metadata: { workspaceId: workspace.id, reason: reason || 'Owner account deleted', ownerDeleted: user.id },
        req,
        transaction,
      });
    }

    const before = user.status;
    await user.update(
      {
        email: `deleted+${user.id}@deleted.invalid`,
        phone: null,
        fullName: 'Deleted user',
        username: null,
        passwordHash: null,
        phoneVerifiedAt: null,
        status: 'suspended',
        suspendedAt: user.suspendedAt || now,
        suspendedReason: reason || user.suspendedReason || null,
        deletedAt: now,
      },
      { transaction }
    );
    const sessionsRevoked = await revokeSessions(user.id, transaction);
    await recordAudit({
      actorUserId: req.user.id,
      action: 'user.delete',
      entityType: 'User',
      entityId: user.id,
      before: { status: before },
      after: { status: 'suspended', deleted: true },
      metadata: { reason: reason || null, sessionsRevoked, suspendedStores },
      req,
      transaction,
    });
    return { ...view(user), suspendedStores };
  });
}

module.exports = { suspend, unsuspend, remove, lockTarget };
