'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./inventoryController');
const schemas = require('./inventoryValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get('/:variantId', requirePermission(PERMISSIONS.INVENTORY_VIEW), controller.getStock);
router.post('/:variantId/adjust', validate(schemas.adjust), requirePermission(PERMISSIONS.INVENTORY_MANAGE), controller.adjust);
router.post('/:variantId/restock', validate(schemas.restock), requirePermission(PERMISSIONS.INVENTORY_MANAGE), controller.restock);

module.exports = router;
