'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./customerController');
const schemas = require('./customerValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get('/', validate(schemas.list), requirePermission(PERMISSIONS.CUSTOMERS_VIEW), controller.list);
router.get('/:customerId', validate(schemas.get), requirePermission(PERMISSIONS.CUSTOMERS_VIEW), controller.get);
router.patch('/:customerId', validate(schemas.update), requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), controller.update);
router.patch('/:customerId/blacklist', validate(schemas.blacklist), requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), controller.blacklist);
router.post('/:customerId/addresses', validate(schemas.addAddress), requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), controller.addAddress);
router.patch('/:customerId/addresses/:addressId', validate(schemas.updateAddress), requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), controller.updateAddress);

module.exports = router;
