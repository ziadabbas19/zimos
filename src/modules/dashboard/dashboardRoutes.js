'use strict';
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { recordAudit } = require('../audit/auditService');
const { forViewer } = require('../../core/utils/phoneMask');
const searchService = require('./searchService');
const setupGuideService = require('./setupGuideService');
const bootstrapService = require('./bootstrapService');

/**
 * Dashboard-wide helpers (SPEC §18.6): global search, the setup guide and the
 * member's sidebar shortcuts. Mounted at /api/v1/workspaces/:workspaceId.
 *
 * Any active member may call these: search filters each group by the member's
 * own permissions, the guide shows only yes/no facts, and shortcuts belong to
 * the member. The guards sit on each route, not on the router, so this mount
 * adds nothing to the other /workspaces/:workspaceId routes.
 */
const router = Router({ mergeParams: true });
const member = [authenticate, resolveTenant];
const params = Joi.object({ workspaceId: Joi.string().uuid().required() });

const MAX_SHORTCUTS = 8;
// A dashboard route: "/orders", "/analytics/web" — never a full URL.
const route = Joi.string().max(100).pattern(/^\/[a-z0-9][a-z0-9\-/]*$/);

router.get(
  '/search',
  ...member,
  validate({ params, query: Joi.object({ q: Joi.string().trim().max(100).allow('').default('') }) }),
  // Customers' phones are masked for roles without customers.reveal_sensitive, as in the orders list.
  asyncHandler(async (req, res) => res.json(forViewer(req, await searchService.search(req.tenant, req.query.q))))
);

// What the dashboard's frame reads on every page load, in one answer
// (bootstrapService). Any member; the parts a role may not read are null.
// The id is checked before the membership lookup, so a malformed one is a 422.
router.get(
  '/bootstrap',
  authenticate,
  validate({ params }),
  resolveTenant,
  asyncHandler(async (req, res) => {
    const bootstrap = await bootstrapService.bootstrap(req);
    // One member's own data: never kept by a shared cache, nor by the browser.
    res.set('Cache-Control', 'private, no-store');
    res.json({ bootstrap });
  })
);

router.get(
  '/setup-guide',
  ...member,
  validate({ params }),
  asyncHandler(async (req, res) => res.json(await setupGuideService.setupGuide(req.tenant.workspaceId)))
);

router.get(
  '/shortcuts',
  ...member,
  validate({ params }),
  asyncHandler(async (req, res) => res.json({ shortcuts: req.tenant.membership.navShortcuts || [] }))
);

router.put(
  '/shortcuts',
  ...member,
  validate({ params, body: Joi.object({ shortcuts: Joi.array().items(route).max(MAX_SHORTCUTS).unique().required() }) }),
  asyncHandler(async (req, res) => {
    const { membership, workspaceId } = req.tenant;
    const before = membership.navShortcuts || [];
    await membership.update({ navShortcuts: req.body.shortcuts });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'membership.shortcuts_set',
      entityType: 'Membership',
      entityId: membership.id,
      before: { shortcuts: before },
      after: { shortcuts: req.body.shortcuts },
      req,
    });
    res.json({ shortcuts: membership.navShortcuts });
  })
);

module.exports = router;
