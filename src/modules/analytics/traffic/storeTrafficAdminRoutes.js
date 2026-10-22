'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../../core/security/platformPermissions');
const protection = require('./protectionService');
const insights = require('./visitorInsightsService');
const { console: visitorSchemas } = require('./visitorValidation');

// The console's "Store traffic" page, mounted under /api/v1/admin like the
// rest of the console (after its authenticate). Read-only and not audited.
// Every store's visitors are store data, so it takes workspaces.view.
const router = Router();

const schemas = {
  protection: {
    query: Joi.object({
      range: Joi.string().valid(...Object.keys(protection.RANGES)).default('7d'),
      workspaceId: Joi.string().uuid().optional(),
    }),
  },
};

router.get(
  '/store-traffic/protection',
  can(P.WORKSPACES_VIEW),
  validate(schemas.protection),
  asyncHandler(async (req, res) => res.json(await protection.summary(req.query)))
);

// Every store's visitors, or one store's (?workspaceId=): the same queries as
// the merchant's Visitors section, plus the store and the session's IP hash.
const scope = (req) => ({ workspaceId: req.query.workspaceId || null });
router.get(
  '/store-traffic/summary',
  can(P.WORKSPACES_VIEW),
  validate(visitorSchemas.summary),
  asyncHandler(async (req, res) => res.json(await insights.summary(scope(req), req.query)))
);
router.get(
  '/store-traffic/sessions',
  can(P.WORKSPACES_VIEW),
  validate(visitorSchemas.sessions),
  asyncHandler(async (req, res) => res.json(await insights.sessions(scope(req), req.query, { console: true })))
);
router.get(
  '/store-traffic/sessions/:workspaceId/:sessionId',
  can(P.WORKSPACES_VIEW),
  validate(visitorSchemas.session),
  asyncHandler(async (req, res) => res.json(await insights.sessionTimeline(req.params.workspaceId, req.params.sessionId, { console: true })))
);
router.get(
  '/store-traffic/campaigns',
  can(P.WORKSPACES_VIEW),
  validate(visitorSchemas.campaigns),
  asyncHandler(async (req, res) => res.json(await insights.campaigns(scope(req), req.query)))
);
router.get(
  '/store-traffic/governorates',
  can(P.WORKSPACES_VIEW),
  validate(visitorSchemas.governorates),
  asyncHandler(async (req, res) => res.json(await insights.governorateOutcomes(scope(req), req.query)))
);

module.exports = router;
