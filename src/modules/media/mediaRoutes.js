'use strict';

const { Router } = require('express');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./mediaController');

// Mounted at /api/v1/workspaces/:workspaceId/media — staff. Uploaded images
// are written to local disk under public/uploads and served at /uploads/...
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE));

router.post('/', controller.acceptFile, controller.uploadMedia);

module.exports = router;
