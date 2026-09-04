'use strict';

const { Router } = require('express');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./mediaController');

// Mounted at /api/v1/workspaces/:workspaceId/media — staff. Uploaded images
// go to the storage backend STORAGE_PROVIDER selects (local disk under
// public/uploads, or a Cloudflare R2 bucket).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE));

router.post('/', controller.acceptFile, controller.uploadMedia);

module.exports = router;
