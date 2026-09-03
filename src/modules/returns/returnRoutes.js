'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./returnController');
const schemas = require('./returnValidation');

// Mounted at /api/v1/workspaces/:workspaceId/returns — the workspace-wide
// returns queue + moderation. Order-scoped create/list live on the orders
// router. Restocking is a separate, explicit step and touches stock, so it
// needs inventory.manage.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get('/', validate(schemas.list), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.list);
router.patch('/:returnId', validate(schemas.moderate), requirePermission(PERMISSIONS.ORDERS_MANAGE), controller.moderate);
router.post(
  '/:returnId/restock',
  validate(schemas.restock),
  requirePermission(PERMISSIONS.INVENTORY_MANAGE),
  controller.restock
);

module.exports = router;
