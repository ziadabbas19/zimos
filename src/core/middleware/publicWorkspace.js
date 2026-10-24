'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../errors/AppError');
const { isUuid, normalizeSlug } = require('../utils/workspaceSlug');
const { accessFor, closesStorefront } = require('../../modules/workspaces/workspaceAccessService');
const { isStorePreviewRequest } = require('../security/storePreview');

/**
 * Public storefront scoping (no membership check) — resolves the workspace
 * and sets req.tenant to the same { workspaceId } shape resolveTenant
 * produces, so downstream services behave identically for a shopper or a
 * staff member.
 *
 * A closed workspace 404s. A restricted one — suspended by a platform admin,
 * or unpaid past its grace day (workspaces/workspaceAccessService) — answers
 * 423 STORE_UNAVAILABLE on every public route, with just enough about the
 * store (name, locale) for the storefront to draw its "unavailable" page. No
 * catalogue, cart, checkout or order data is served.
 *
 * A draft store (not subscribed yet, see workspaceAccessService) answers
 * exactly as a store that does not exist — the same 404 — so nothing about
 * it, not even that it exists, reaches the public. Staff previewing it with
 * an X-Store-Preview token see its pages; `refuseDraftOrders` keeps them from
 * ordering.
 */
const resolvePublicWorkspace = asyncHandler(async (req, res, next) => {
  // A public store is addressed either by workspace UUID or by its slug, so
  // links minted before subdomain addressing keep working. Slugs are stored
  // lower-cased and hostnames are case-insensitive, so the lookup matches
  // however the shopper happened to type it.
  const ref = req.params.workspaceId;
  const workspace = await db.Workspace.findOne({
    where: {
      status: ['active', 'suspended'],
      ...(isUuid(ref) ? { id: ref } : { slug: normalizeSlug(ref) }),
    },
  });

  if (!workspace) {
    throw new NotFoundError('Workspace');
  }

  const access = await accessFor(workspace.id, { workspace });
  if (access.draft) {
    if (!isStorePreviewRequest(req, workspace.id)) throw new NotFoundError('Workspace');
    req.draftPreview = true;
  }
  // With ORDERS_LOCK_ENABLED only a suspension closes it (closesStorefront).
  if (closesStorefront(access)) {
    throw new AppError('STORE_UNAVAILABLE', 'This store is currently unavailable.', 423, {
      store: {
        name: workspace.name,
        slug: workspace.slug,
        defaultLocale: workspace.defaultLocale,
        logoUrl: workspace.logoUrl,
      },
    });
  }

  req.publicWorkspace = workspace;
  req.tenant = { workspaceId: workspace.id, hasPermission: () => false };
  next();
});

/**
 * On the routes that place an order or record a shopper (checkout, the
 * checkout autosave, a funnel step that can order): a draft store, reachable
 * here only through a staff preview, sells nothing — 403
 * SUBSCRIPTION_REQUIRED, as the dashboard's own guard answers.
 */
const refuseDraftOrders = asyncHandler(async (req, res, next) => {
  if (req.draftPreview) {
    const { subscriptionRequiredError } = require('../../modules/billing/goLiveService');
    throw await subscriptionRequiredError(req.publicWorkspace.id);
  }
  next();
});

module.exports = { resolvePublicWorkspace, refuseDraftOrders };
