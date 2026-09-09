'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { NotFoundError } = require('../errors/AppError');

/**
 * Public storefront scoping (no membership check) — resolves an active
 * workspace and sets req.tenant to the same { workspaceId } shape
 * resolveTenant produces, so downstream services behave identically for a
 * shopper or a staff member. A suspended/closed workspace 404s.
 */
const resolvePublicWorkspace = asyncHandler(async (req, res, next) => {
  const workspaceId = req.params.workspaceId;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId);
  const workspace = await db.Workspace.findOne({
    where: { status: 'active', ...(isUuid ? { id: workspaceId } : { slug: workspaceId }) },
  });

  if (!workspace) {
    throw new NotFoundError('Workspace');
  }

  req.publicWorkspace = workspace;
  req.tenant = { workspaceId: workspace.id, hasPermission: () => false };
  next();
});

module.exports = { resolvePublicWorkspace };
