'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { NotFoundError, AuthenticationError } = require('../errors/AppError');

/**
 * Resolves the workspace this request targets and verifies req.user is an
 * active member, attaching req.tenant = { workspaceId, membership, role,
 * hasPermission(perm) }. This is the one choke point for tenant isolation:
 * the membership lookup below decides workspaceId, never a value from the
 * request body.
 */
const resolveTenant = asyncHandler(async (req, res, next) => {
  if (!req.user) throw new AuthenticationError();

  const workspaceId = req.params.workspaceId || req.headers['x-workspace-id'];
  if (!workspaceId) {
    throw new NotFoundError('Workspace');
  }

  const membership = await db.Membership.findOne({
    where: { workspaceId, userId: req.user.id, status: 'active' },
    include: [{ model: db.Role, as: 'role' }],
  });

  // Same error whether the workspace is missing or the user isn't a member,
  // so response differences can't be used to enumerate workspace IDs.
  if (!membership) {
    throw new NotFoundError('Workspace');
  }

  const permissions = membership.role.permissions;

  req.tenant = {
    workspaceId,
    membership,
    role: membership.role,
    hasPermission(permission) {
      return permissions.includes('*') || permissions.includes(permission);
    },
  };

  next();
});

module.exports = { resolveTenant };
