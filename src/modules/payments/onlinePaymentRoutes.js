'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./onlinePaymentController');
const schemas = require('./onlinePaymentValidation');

// Mounted at /api/v1/workspaces/:workspaceId/payments.
//
// Payment settings belong to the owner and the workspace manager (the roles
// holding workspace.manage) and to nobody else: whoever controls these keys
// controls where the store's money goes.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const manage = requirePermission(PERMISSIONS.WORKSPACE_MANAGE);

router.get('/gateways', validate(schemas.workspace), manage, controller.listGateways);
router.put('/gateways/:code', validate(schemas.connect), manage, controller.connectGateway);
router.delete('/gateways/:code', validate(schemas.gateway), manage, controller.disconnectGateway);
router.get('/methods', validate(schemas.workspace), manage, controller.listMethods);
router.put('/methods', validate(schemas.updateMethods), manage, controller.updateMethods);
router.post('/preview-token', validate(schemas.workspace), manage, controller.previewToken);

module.exports = router;
