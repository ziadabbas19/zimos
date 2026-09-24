'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission, requireAnyPermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./confirmationController');
const schemas = require('./confirmationValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

// Agents work the queue (orders.confirm); managers (orders.manage) read it to
// correct outcomes and free stuck tasks, without being able to make calls.
const agentOrManager = requireAnyPermission(PERMISSIONS.ORDERS_CONFIRM, PERMISSIONS.ORDERS_MANAGE);

router.get('/', validate(schemas.listQueue), agentOrManager, controller.listQueue);
router.get('/counts', validate(schemas.counts), agentOrManager, controller.counts);
router.post('/:taskId/claim', validate(schemas.claim), requirePermission(PERMISSIONS.ORDERS_CONFIRM), controller.claim);
router.post('/:taskId/outcome', validate(schemas.outcome), requirePermission(PERMISSIONS.ORDERS_CONFIRM), controller.outcome);
// The holder releases their own claim; releasing someone else's needs
// orders.manage, which the service checks.
router.post('/:taskId/release', validate(schemas.release), agentOrManager, controller.release);
router.post('/:taskId/correction', validate(schemas.correction), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.correction);

module.exports = router;
