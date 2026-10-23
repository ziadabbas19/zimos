'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requirePlanFeature } = require('../billing/planFeatureGate');
const controller = require('./apiKeyController');
const schemas = require('./apiKeyValidation');

// Mounted at /api/v1/workspaces/:workspaceId/api-keys. Managing keys is the
// dashboard's job (staff JWT); the keys themselves are used against
// /api/v1/public (modules/publicApi).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.API_KEYS_MANAGE));

router.get('/', validate(schemas.list), controller.list);
// Minting a key needs api_access while PLAN_FEATURE_ENFORCEMENT is on
// (billing/planFeatureGate). Only minting: listing and revoking stay open,
// and a key already minted keeps working on any plan — the public API
// (apiKeyAuth) never asks about the plan.
router.post('/', validate(schemas.create), requirePlanFeature('api_access'), controller.create);
router.delete('/:keyId', validate(schemas.revoke), controller.revoke);

module.exports = router;
