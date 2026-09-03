'use strict';

const slugify = require('../../core/utils/slugify');
const db = require('../../db/models');
const { SYSTEM_ROLES } = require('../../core/security/permissions');
const { ConflictError, NotFoundError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');
const billingService = require('../billing/billingService');

async function sendInviteEmail(workspace, email, role) {
  await notify.email({
    workspaceId: workspace.id,
    recipient: email,
    template: 'workspace_invite',
    data: { workspaceName: workspace.name, roleName: role.name },
  });
}

async function createWorkspace({ name, ownerUserId }, req) {
  const baseSlug = slugify(name);

  return db.sequelize.transaction(async (t) => {
    // Guarantee a unique slug even under concurrent creation of workspaces
    // with the same name, by retrying with a numeric suffix inside the same
    // transaction rather than checking-then-inserting (which would race).
    let slug = baseSlug;
    let suffix = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const clash = await db.Workspace.findOne({ where: { slug }, transaction: t });
      if (!clash) break;
      slug = `${baseSlug}-${++suffix}`;
    }

    const workspace = await db.Workspace.create({ name, slug, ownerUserId }, { transaction: t });

    // Sequential, not Promise.all: a single Sequelize transaction runs on one
    // pooled connection, and concurrent queries against the same connection
    // are unsafe/undefined behavior in node-postgres.
    const roles = [];
    for (const r of Object.values(SYSTEM_ROLES)) {
      roles.push(
        await db.Role.create(
          { workspaceId: workspace.id, key: r.key, name: r.name, isSystem: true, permissions: r.permissions },
          { transaction: t }
        )
      );
    }
    const ownerRole = roles.find((r) => r.key === 'owner');

    await db.Membership.create(
      { workspaceId: workspace.id, userId: ownerUserId, roleId: ownerRole.id, status: 'active' },
      { transaction: t }
    );

    await db.InvoiceCounter.create({ workspaceId: workspace.id, lastNumber: 0 }, { transaction: t });

    // Every workspace starts on a trialing subscription (no card, no gateway).
    await billingService.ensureSubscriptionForWorkspace(workspace.id, t);

    await recordAudit({
      workspaceId: workspace.id,
      actorUserId: ownerUserId,
      action: 'workspace.create',
      entityType: 'Workspace',
      entityId: workspace.id,
      req,
      transaction: t,
    });

    return workspace;
  });
}

async function listWorkspacesForUser(userId) {
  const memberships = await db.Membership.findAll({
    where: { userId, status: 'active' },
    include: [
      { model: db.Workspace, as: 'workspace' },
      { model: db.Role, as: 'role' },
    ],
  });
  return memberships.map((m) => ({
    workspace: m.workspace,
    role: { key: m.role.key, name: m.role.name },
  }));
}

async function inviteMember({ workspaceId, email, roleId }, req) {
  const role = await db.Role.findOne({ where: { id: roleId, workspaceId } });
  if (!role) throw new NotFoundError('Role');

  const user = await db.User.findOne({ where: { email } });

  if (user) {
    const existing = await db.Membership.findOne({ where: { workspaceId, userId: user.id } });
    if (existing) throw new ConflictError('User is already a member of this workspace', 'ALREADY_MEMBER');
  } else {
    const pending = await db.Membership.findOne({ where: { workspaceId, invitedEmail: email } });
    if (pending) throw new ConflictError('That email already has a pending invite', 'ALREADY_INVITED');
  }

  const membership = await db.Membership.create({
    workspaceId,
    userId: user ? user.id : null,
    roleId,
    status: user ? 'active' : 'invited',
    invitedEmail: user ? null : email,
  });

  const workspace = await db.Workspace.findByPk(workspaceId);
  await sendInviteEmail(workspace, email, role);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'membership.invite',
    entityType: 'Membership',
    entityId: membership.id,
    after: { email, roleId },
    req,
  });

  return membership;
}

async function listMembers(workspaceId) {
  return db.Membership.findAll({
    where: { workspaceId },
    include: [
      { model: db.User, as: 'user', attributes: ['id', 'email', 'fullName', 'status'] },
      { model: db.Role, as: 'role', attributes: ['id', 'key', 'name'] },
    ],
    order: [['createdAt', 'ASC']],
  });
}

async function listPendingInvites(workspaceId) {
  return db.Membership.findAll({
    where: { workspaceId, status: 'invited' },
    include: [{ model: db.Role, as: 'role', attributes: ['id', 'key', 'name'] }],
    order: [['createdAt', 'ASC']],
  });
}

async function resendInvite({ workspaceId, membershipId }, req) {
  const membership = await db.Membership.findOne({
    where: { id: membershipId, workspaceId },
    include: [{ model: db.Role, as: 'role' }],
  });
  if (!membership) throw new NotFoundError('Membership');
  if (membership.status !== 'invited') {
    throw new AppError('NOT_PENDING', 'That invite has already been accepted', 409);
  }

  const workspace = await db.Workspace.findByPk(workspaceId);
  await sendInviteEmail(workspace, membership.invitedEmail, membership.role);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'membership.invite_resend',
    entityType: 'Membership',
    entityId: membership.id,
    after: { email: membership.invitedEmail },
    req,
  });

  return { resent: true, email: membership.invitedEmail };
}

async function updateMemberRole({ workspaceId, membershipId, roleId }, req) {
  const membership = await db.Membership.findOne({ where: { id: membershipId, workspaceId } });
  if (!membership) throw new NotFoundError('Membership');

  const role = await db.Role.findOne({ where: { id: roleId, workspaceId } });
  if (!role) throw new NotFoundError('Role');

  const targetOwnerRole = await db.Role.findOne({ where: { workspaceId, key: 'owner' } });
  if (membership.roleId === targetOwnerRole.id && role.id !== targetOwnerRole.id) {
    const ownerCount = await db.Membership.count({ where: { workspaceId, roleId: targetOwnerRole.id, status: 'active' } });
    if (ownerCount <= 1) {
      throw new AppError('LAST_OWNER', 'Cannot remove the last Owner of a workspace', 409);
    }
  }

  const before = { roleId: membership.roleId };
  await membership.update({ roleId });

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'membership.role_change',
    entityType: 'Membership',
    entityId: membership.id,
    before,
    after: { roleId },
    req,
  });

  return membership;
}

async function removeMember({ workspaceId, membershipId }, req) {
  const membership = await db.Membership.findOne({ where: { id: membershipId, workspaceId }, include: [{ model: db.Role, as: 'role' }] });
  if (!membership) throw new NotFoundError('Membership');

  if (membership.role.key === 'owner') {
    const ownerCount = await db.Membership.count({
      where: { workspaceId, status: 'active' },
      include: [{ model: db.Role, as: 'role', where: { key: 'owner' } }],
    });
    if (ownerCount <= 1) {
      throw new AppError('LAST_OWNER', 'Cannot remove the last Owner of a workspace', 409);
    }
  }

  await membership.destroy();

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'membership.remove',
    entityType: 'Membership',
    entityId: membershipId,
    req,
  });

  return { success: true };
}

async function createCustomRole({ workspaceId, name, key, permissions }, req) {
  const role = await db.Role.create({ workspaceId, key, name, isSystem: false, permissions });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'role.create',
    entityType: 'Role',
    entityId: role.id,
    after: { name, key, permissions },
    req,
  });
  return role;
}

module.exports = {
  createWorkspace,
  listWorkspacesForUser,
  inviteMember,
  listMembers,
  listPendingInvites,
  resendInvite,
  updateMemberRole,
  removeMember,
  createCustomRole,
};
