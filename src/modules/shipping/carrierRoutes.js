'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission, requireAnyPermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./carrierController');
const schemas = require('./carrierValidation');

// Mounted at /api/v1/workspaces/:workspaceId/carriers.
//
// Connecting and disconnecting is shipping settings (shipping.manage). The two
// reads are also what the create-shipment dialog needs — which couriers are
// connected, and the city picker — so orders.manage may use them too.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const readAccess = requireAnyPermission(PERMISSIONS.SHIPPING_MANAGE, PERMISSIONS.ORDERS_MANAGE);

router.get('/', validate(schemas.list), readAccess, controller.list);
router.put('/:code', validate(schemas.connect), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.connect);
router.delete('/:code', validate(schemas.byCode), requirePermission(PERMISSIONS.SHIPPING_MANAGE), controller.disconnect);
router.get('/:code/cities', validate(schemas.cities), readAccess, controller.cities);

module.exports = router;
