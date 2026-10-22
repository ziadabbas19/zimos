'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../../core/middleware/validate');
const { requirePlatformPermission: can } = require('../../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../../core/security/platformPermissions');
const protection = require('./protectionService');

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

module.exports = router;
