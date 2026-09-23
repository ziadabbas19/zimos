'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./checkoutSessionController');
const schemas = require('./checkoutSessionValidation');

// Merchant side of abandoned checkouts. The public autosave lives with the
// other storefront routes (storefront/storefrontRoutes.js).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get('/', validate(schemas.list), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.list);
router.patch('/:sessionId', validate(schemas.update), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.update);

module.exports = router;
