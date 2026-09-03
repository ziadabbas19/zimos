'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./discountController');
const schemas = require('./discountValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.DISCOUNTS_MANAGE));

router.post('/', validate(schemas.create), controller.create);
router.get('/', validate(schemas.list), controller.list);
router.get('/:discountId', validate(schemas.get), controller.get);
router.patch('/:discountId/status', validate(schemas.setStatus), controller.setStatus);
router.patch('/:discountId', validate(schemas.update), controller.update);
router.delete('/:discountId', validate(schemas.remove), controller.remove);

module.exports = router;
