'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./webhookController');
const { newEndpointGate } = require('./webhookPlanGate');
const schemas = require('./webhookValidation');

// Mounted at /api/v1/workspaces/:workspaceId/webhooks. The merchant's
// endpoints and their delivery history; the events themselves are produced
// by orderChangeDetector.js and sent by webhookDispatcher.js.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBHOOKS_MANAGE));

// The store-wide delivery log and "resend order" — before the /:endpointId routes.
router.use(require('./webhookExtraRoutes'));

router.get('/events', validate(schemas.list), controller.events);
router.get('/', validate(schemas.list), controller.list);
// WEBHOOKS_REQUIRE_API_ACCESS: a new endpoint needs api_access (webhookPlanGate.js).
router.post('/', validate(schemas.create), newEndpointGate, controller.create);
router.patch('/:endpointId', validate(schemas.update), controller.update);
router.delete('/:endpointId', validate(schemas.byId), controller.remove);
router.post('/:endpointId/rotate-secret', validate(schemas.byId), controller.rotateSecret);
router.post('/:endpointId/test', validate(schemas.byId), controller.test);
router.get('/:endpointId/deliveries', validate(schemas.deliveries), controller.deliveries);
router.post('/:endpointId/deliveries/:deliveryId/redeliver', validate(schemas.redeliver), controller.redeliver);

module.exports = router;
