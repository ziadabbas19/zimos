'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./shippingController');
const schemas = require('./shippingValidation');

// Mounted at /api/v1/workspaces/:workspaceId/shipping — staff, `shipping.manage`.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.SHIPPING_MANAGE));

// --- Zones -----------------------------------------------------------------
router.get('/zones', validate(schemas.listZones), controller.listZones);
router.post('/zones', validate(schemas.createZone), controller.createZone);
router.get('/zones/:zoneId', validate(schemas.zoneParams), controller.getZone);
router.patch('/zones/:zoneId', validate(schemas.updateZone), controller.updateZone);
router.delete('/zones/:zoneId', validate(schemas.zoneParams), controller.deleteZone);

// --- Rates -----------------------------------------------------------------
router.get('/zones/:zoneId/rates', validate(schemas.zoneParams), controller.listRates);
router.post('/zones/:zoneId/rates', validate(schemas.createRate), controller.createRate);
router.get('/rates/:rateId', validate(schemas.rateParams), controller.getRate);
router.patch('/rates/:rateId', validate(schemas.updateRate), controller.updateRate);
router.delete('/rates/:rateId', validate(schemas.rateParams), controller.deleteRate);

module.exports = router;
