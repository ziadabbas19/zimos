'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./taxController');
const schemas = require('./taxValidation');

// Mounted at /api/v1/workspaces/:workspaceId/tax-rates — staff, `tax.manage`.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.TAX_MANAGE));

router.get('/', validate(schemas.list), controller.list);
router.post('/', validate(schemas.create), controller.create);
router.get('/:taxRateId', validate(schemas.params), controller.get);
router.patch('/:taxRateId', validate(schemas.update), controller.update);
router.delete('/:taxRateId', validate(schemas.params), controller.remove);

module.exports = router;
