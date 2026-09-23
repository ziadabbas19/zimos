'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./mediaController');
const schemas = require('./mediaValidation');

// Mounted at /api/v1/workspaces/:workspaceId/media — staff. Uploaded images
// go to the storage backend STORAGE_PROVIDER selects (local disk under
// public/uploads, or a Cloudflare R2 bucket).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE));

router.post('/', controller.acceptFile, controller.uploadMedia);
// The library the builder's image picker reads, and the only way to take a
// file back out of it. Same permission as upload: whoever may add product
// images may manage them.
router.get('/', validate(schemas.list), controller.listMedia);
router.delete('/:mediaId', validate(schemas.remove), controller.deleteMedia);

module.exports = router;
