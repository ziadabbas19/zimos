'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./fraudController');
const schemas = require('./fraudValidation');

// Unblocking stays on PATCH /customers/:customerId/blacklist.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get('/flagged-orders', validate(schemas.listFlagged), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.listFlagged);
router.post(
  '/flagged-orders/:orderId/approve',
  validate(schemas.approve),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.approve
);
router.get('/blocklist', validate(schemas.listBlocklist), requirePermission(PERMISSIONS.CUSTOMERS_VIEW), controller.listBlocklist);
router.post('/blocklist', validate(schemas.block), requirePermission(PERMISSIONS.CUSTOMERS_MANAGE), controller.block);

module.exports = router;
