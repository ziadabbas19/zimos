'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./confirmationController');
const schemas = require('./confirmationValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.ORDERS_CONFIRM));

router.get('/', validate(schemas.listQueue), controller.listQueue);
router.post('/:taskId/claim', validate(schemas.claim), controller.claim);
router.post('/:taskId/outcome', validate(schemas.outcome), controller.outcome);

module.exports = router;
