'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./reviewController');
const schemas = require('./reviewValidation');

// Mounted at /api/v1/workspaces/:workspaceId/reviews — staff moderation.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE));

router.get('/', validate(schemas.list), controller.list);
router.patch('/:reviewId', validate(schemas.moderate), controller.moderate);

module.exports = router;
