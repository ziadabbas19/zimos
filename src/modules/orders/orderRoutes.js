'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { idempotent } = require('../../core/middleware/idempotency');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./orderController');
const schemas = require('./orderValidation');
const returnController = require('../returns/returnController');
const returnSchemas = require('../returns/returnValidation');
const waybillController = require('../waybill/waybillController');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.post(
  '/',
  validate(schemas.create),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  idempotent('order.create')(controller.create)
);
router.get('/', validate(schemas.list), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.list);
router.get('/:orderId', validate(schemas.get), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.get);

router.post(
  '/:orderId/cancel',
  validate(schemas.cancel),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.cancel
);
router.patch(
  '/:orderId',
  validate(schemas.update),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.update
);

router.get(
  '/:orderId/shipments',
  validate(schemas.listShipments),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  controller.listShipments
);
router.post(
  '/:orderId/shipments',
  validate(schemas.createShipment),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.createShipment
);
router.patch(
  '/:orderId/shipments/:shipmentId',
  validate(schemas.updateShipment),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.updateShipment
);

router.get(
  '/:orderId/returns',
  validate(returnSchemas.listForOrder),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  returnController.listForOrder
);
router.post(
  '/:orderId/returns',
  validate(returnSchemas.create),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  returnController.create
);

router.get(
  '/:orderId/waybill',
  validate(schemas.get),
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  waybillController.waybill
);

module.exports = router;
