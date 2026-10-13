'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const {
  AppError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { isVerified } = require('../auth/signupPolicy');
const {
  ALL_PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  WILDCARD,
  hasPlatformPermission,
} = require('../../core/security/platformPermissions');

/**
 * Who may use the platform console, and what they may do there: a role and a
 * permission set on an existing account (users.platform_role and
 * users.platform_permissions, migration 105). There are no invitations — the
 * person signs up first, then is given a role by email.
 *
 * Assigning a role copies its default permission set (platform_roles) onto
 * the account unless an explicit set is given; the set can be edited later.
 * Every route checks the set, never the role.
 *
 * The role still matters for a few rules that protect the console itself:
 *
 *   - only a creator assigns the creator role or changes a creator's account;
 *   - nobody edits or revokes their own access (another user has to);
 *   - the last creator is never demoted or revoked;
 *   - '*' (every permission) belongs to the creator role only;
 *   - an explicit set may only hold keys the actor holds themselves, or keys
 *     in the target role's own default set (so an admin can create an agent
 *     without holding the agent-only key).
 *
 * `authenticate` reloads the user on every request, so a change takes effect
 * on that user's very next call; no token has to expire first.
 *
 * Demoting and revoking row-lock every creator plus the two accounts involved,
 * in id order. Two creators revoking each other at the same moment are
 * serialized, and the second one finds itself no longer allowed.
 */

const ADMIN_ATTRIBUTES = [
  'id',
  'email',
  'fullName',
  'status',
  'lastLoginAt',
  'createdAt',
  'platformRole',
  'platformPermissions',
];

function roleAccessState(user) {
  return {
    platformRole: user.platformRole || null,
    platformPermissions: Array.isArray(user.platformPermissions) ? [...user.platformPermissions] : [],
  };
}

function serializeAdmin(user, viewerId, roleNames = new Map()) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    role: user.platformRole,
    roleName: roleNames.get(user.platformRole) || user.platformRole,
    permissions: Array.isArray(user.platformPermissions) ? user.platformPermissions : [],
    isYou: user.id === viewerId,
  };
}

function serializeRole(role) {
  return {
    key: role.key,
    name: role.name,
    description: role.description,
    defaultPermissions: role.defaultPermissions,
  };
}

async function roleNameMap(transaction) {
  const roles = await db.PlatformRole.findAll({ attributes: ['key', 'name'], transaction });
  return new Map(roles.map((r) => [r.key, r.name]));
}

async function listRoles() {
  const roles = await db.PlatformRole.findAll({ order: [['createdAt', 'ASC'], ['key', 'ASC']] });
  return { roles: roles.map(serializeRole), permissions: ALL_PLATFORM_PERMISSIONS };
}

async function listAdmins(viewerId) {
  const [users, names] = await Promise.all([
    db.User.findAll({
      where: { platformRole: { [Op.ne]: null } },
      attributes: ADMIN_ATTRIBUTES,
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    }),
    roleNameMap(),
  ]);
  return users.map((u) => serializeAdmin(u, viewerId, names));
}

async function findRole(key, transaction) {
  const role = await db.PlatformRole.findByPk(key, { transaction });
  if (!role) {
    throw new ValidationError([{ field: 'role', message: `Unknown role "${key}"` }], 'Invalid body');
  }
  return role;
}

function requireCreator(actor, message) {
  if (actor.platformRole !== PLATFORM_ROLES.CREATOR) {
    throw new AppError('CREATOR_REQUIRED', message, 403);
  }
}

/**
 * The set an account ends up with: the role's default unless `requested` is
 * given, deduplicated, and checked against the rules in the header comment.
 * `current` is what the account holds today under this same role: keeping a
 * key it already has is not granting it, so the actor need not hold it.
 */
function resolvePermissions(role, requested, actor, current = []) {
  const defaults = role.defaultPermissions || [];
  if (requested === undefined) return [...new Set(defaults)];

  const set = [...new Set(requested)];
  const errors = [];
  for (const key of set) {
    if (key === WILDCARD) {
      if (role.key !== PLATFORM_ROLES.CREATOR) {
        errors.push({ field: 'permissions', message: '"*" (every permission) is reserved for the creator role' });
      }
    } else if (!ALL_PLATFORM_PERMISSIONS.includes(key)) {
      errors.push({ field: 'permissions', message: `Unknown permission "${key}"` });
    }
  }
  if (errors.length) throw new ValidationError(errors, 'Invalid body');

  const notHeld = set.filter(
    (key) => !defaults.includes(key) && !current.includes(key) && !hasPlatformPermission(actor, key)
  );
  if (notHeld.length) {
    throw new AppError(
      'PERMISSION_NOT_HELD',
      `You can only grant permissions you hold yourself (missing: ${notHeld.join(', ')}).`,
      403
    );
  }
  return set;
}

async function auditRoleChange(action, req, user, before, after, transaction) {
  await recordAudit({
    actorUserId: req.user.id,
    action,
    entityType: 'User',
    entityId: user.id,
    before,
    after,
    metadata: { email: user.email },
    req,
    transaction,
  });
}

/**
 * Locks every creator plus the target and the requester, in id order, and
 * re-checks the requester under that lock: someone whose access was changed
 * a moment ago must not complete a change that was already in flight.
 * `permission` is the one the route asked of the requester. `anyTarget` is for
 * a grant, whose target has no role yet and is read whole.
 */
async function lockForRoleChange(userId, req, transaction, { permission = PLATFORM_PERMISSIONS.ADMINS_MANAGE, anyTarget = false } = {}) {
  const rows = await db.User.findAll({
    where: {
      [Op.or]: [{ platformRole: PLATFORM_ROLES.CREATOR }, { id: [userId, req.user.id] }],
    },
    ...(anyTarget
      ? {}
      : { attributes: ['id', 'email', 'fullName', 'status', 'lastLoginAt', 'createdAt', 'deletedAt', 'platformRole', 'platformPermissions'] }),
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  const requester = rows.find((u) => u.id === req.user.id);
  if (!requester || requester.status !== 'active' || requester.deletedAt || !hasPlatformPermission(requester, permission)) {
    throw new AuthorizationError(`Missing required platform permission: ${permission}`);
  }
  const target = rows.find((u) => u.id === userId);
  if (!target || (!anyTarget && !target.platformRole)) throw new NotFoundError('Platform user');
  const creators = rows.filter((u) => u.platformRole === PLATFORM_ROLES.CREATOR);
  return { requester, target, creators };
}

/**
 * Gives an existing, active account `roleKey` (and `permissions`, else the
 * role's default). Idempotent for the same role: an account that already has
 * it comes back unchanged with `granted: false` and no audit row. An account
 * holding a different role is refused — changing a role is `updateAdmin`.
 *
 * Runs inside the caller's transaction so agent creation (gated by
 * agents.manage rather than admins.manage, hence `permission`) can add the
 * agent's first referral code atomically with the role.
 *
 * Who may grant is decided on the requester's row as it is under the lock,
 * not on the copy the request was authenticated with: a requester whose own
 * access was revoked a moment ago must not finish a grant already in flight.
 * Nobody grants a role to their own account.
 */
async function grantRoleInTransaction({ email, role: roleKey, permissions }, req, transaction, { permission = PLATFORM_PERMISSIONS.ADMINS_MANAGE } = {}) {
  const role = await findRole(roleKey, transaction);
  // Answered before the account is looked up, as it always was; decided again
  // below on the locked row.
  if (role.key === PLATFORM_ROLES.CREATOR) {
    requireCreator(req.user, 'Only a creator can make someone a creator.');
  }

  const notFound = () =>
    new AppError(
      'USER_NOT_FOUND',
      'No account uses that email. The person has to sign up before they can be given console access.',
      404
    );
  // users.email is CITEXT, so this match ignores case. Read without a lock,
  // only to learn which row to lock: the rows are then locked in id order, as
  // the demote and revoke paths lock them, so a grant cannot deadlock with one.
  const found = await db.User.findOne({ where: { email: email.trim() }, attributes: ['id'], transaction });
  if (!found) throw notFound();
  if (found.id === req.user.id) {
    throw new ConflictError('You cannot give your own account a role. Ask another creator to do it.', 'CANNOT_ACT_ON_SELF');
  }

  const { requester, target: user } = await lockForRoleChange(found.id, req, transaction, { permission, anyTarget: true });
  if (role.key === PLATFORM_ROLES.CREATOR) {
    requireCreator(requester, 'Only a creator can make someone a creator.');
  }
  // The address moved to another account between the two reads.
  if (String(user.email).toLowerCase() !== email.trim().toLowerCase()) throw notFound();

  if (user.platformRole === role.key) {
    return { user, granted: false };
  }
  if (user.platformRole) {
    throw new ConflictError(
      `That account already has the ${user.platformRole} role. Change its role from the admin users list instead.`,
      'ALREADY_PLATFORM_USER'
    );
  }
  // Active is no longer enough: a new account is active before its email is
  // confirmed, and anyone can sign up with an address they don't own.
  if (user.status !== 'active' || !isVerified(user)) {
    throw new ConflictError(
      user.status === 'suspended'
        ? 'That account is suspended and cannot be given console access.'
        : 'That account has not confirmed its email yet. Try again once it has.',
      'USER_NOT_ACTIVE'
    );
  }

  const before = roleAccessState(user);
  await user.update(
    { platformRole: role.key, platformPermissions: resolvePermissions(role, permissions, requester) },
    { transaction }
  );
  await auditRoleChange('platform_admin.grant', req, user, before, roleAccessState(user), transaction);
  return { user, granted: true };
}

async function grantAdmin(body, req) {
  return db.sequelize.transaction(async (transaction) => {
    const { user, granted } = await grantRoleInTransaction(body, req, transaction);
    return { admin: serializeAdmin(user, req.user.id, await roleNameMap(transaction)), granted };
  });
}
async function updateAdmin(userId, { role: roleKey, permissions }, req) {
  if (userId === req.user.id) {
    throw new ConflictError('You cannot change your own role or permissions. Ask another creator to do it.', 'CANNOT_EDIT_SELF');
  }

  return db.sequelize.transaction(async (transaction) => {
    const { requester, target, creators } = await lockForRoleChange(userId, req, transaction);
    const role = await findRole(roleKey || target.platformRole, transaction);

    if (target.platformRole === PLATFORM_ROLES.CREATOR) {
      requireCreator(requester, "Only a creator can change a creator's access.");
    }
    if (role.key === PLATFORM_ROLES.CREATOR) {
      requireCreator(requester, 'Only a creator can make someone a creator.');
    }
    const demotesCreator = target.platformRole === PLATFORM_ROLES.CREATOR && role.key !== PLATFORM_ROLES.CREATOR;
    if (demotesCreator && creators.length <= 1) {
      throw new ConflictError('This is the last creator, so their role cannot be changed.', 'LAST_CREATOR');
    }

    // A role change without an explicit set resets to the new role's default;
    // a set without a role change replaces the set and keeps the role.
    const roleChanged = role.key !== target.platformRole;
    const nextPermissions =
      permissions !== undefined
        ? resolvePermissions(role, permissions, requester, roleChanged ? [] : target.platformPermissions)
        : roleChanged
          ? resolvePermissions(role, undefined, requester)
          : target.platformPermissions;

    const before = roleAccessState(target);
    await target.update({ platformRole: role.key, platformPermissions: nextPermissions }, { transaction });
    await auditRoleChange('platform_admin.update', req, target, before, roleAccessState(target), transaction);
    return serializeAdmin(target, req.user.id, await roleNameMap(transaction));
  });
}

async function revokeAdmin(userId, req) {
  if (userId === req.user.id) {
    throw new ConflictError('You cannot revoke your own access. Ask another creator to do it.', 'CANNOT_REVOKE_SELF');
  }

  return db.sequelize.transaction(async (transaction) => {
    const { requester, target, creators } = await lockForRoleChange(userId, req, transaction);
    if (target.platformRole === PLATFORM_ROLES.CREATOR) {
      requireCreator(requester, "Only a creator can revoke a creator's access.");
      if (creators.length <= 1) {
        throw new ConflictError('This is the last creator, so their access cannot be revoked.', 'LAST_CREATOR');
      }
    }

    const before = roleAccessState(target);
    await target.update({ platformRole: null, platformPermissions: [] }, { transaction });
    await auditRoleChange('platform_admin.revoke', req, target, before, roleAccessState(target), transaction);
    return { success: true };
  });
}

module.exports = {
  listRoles,
  listAdmins,
  grantAdmin,
  grantRoleInTransaction,
  updateAdmin,
  revokeAdmin,
  serializeAdmin,
};
