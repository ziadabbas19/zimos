'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { NotFoundError } = require('../errors/AppError');
const { isUuid, normalizeSlug } = require('../utils/workspaceSlug');

/**
 * Public storefront scoping (no membership check) — resolves an active
 * workspace and sets req.tenant to the same { workspaceId } shape
 * resolveTenant produces, so downstream services behave identically for a
 * shopper or a staff member. A suspended/closed workspace 404s.
 */
const resolvePublicWorkspace = asyncHandler(async (req, res, next) => {
  // A public store is addressed either by workspace UUID or by its slug, so
  // links minted before subdomain addressing keep working. Slugs are stored
  // lower-cased and hostnames are case-insensitive, so the lookup matches
  // however the shopper happened to type it.
  const ref = req.params.workspaceId;
  const workspace = await db.Workspace.findOne({
    where: { status: 'active', ...(isUuid(ref) ? { id: ref } : { slug: normalizeSlug(ref) }) },
  });

  if (!workspace) {
    throw new NotFoundError('Workspace');
  }

  req.publicWorkspace = workspace;
  req.tenant = { workspaceId: workspace.id, hasPermission: () => false };
  next();
});

module.exports = { resolvePublicWorkspace };
