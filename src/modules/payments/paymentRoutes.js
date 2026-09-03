'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./paymentController');
const schemas = require('./paymentValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.post('/orders/:orderId/payments', validate(schemas.initialize), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.initialize);
router.post('/payments/:paymentId/capture', validate(schemas.capture), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.capture);
router.post('/orders/:orderId/refunds', validate(schemas.refund), requirePermission(PERMISSIONS.REFUNDS_MANAGE), controller.refund);

module.exports = router;
