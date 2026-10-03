'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { idempotent } = require('../../core/middleware/idempotency');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requireLive } = require('../../core/middleware/subscriptionGuard');
const controller = require('./orderController');
const schemas = require('./orderValidation');
const returnController = require('../returns/returnController');
const returnSchemas = require('../returns/returnValidation');
const waybillController = require('../waybill/waybillController');
const carrierController = require('../shipping/carrierController');
const carrierSchemas = require('../shipping/carrierValidation');
const exportController = require('./orderExportController');
const exportSchemas = require('./orderExportValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

// A draft store (not subscribed yet) takes no orders, by hand either.
router.post(
  '/',
  validate(schemas.create),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  requireLive,
  idempotent('order.create')(controller.create)
);
router.get('/', validate(schemas.list), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.list);
// Before '/:orderId', or Express matches "pipeline" as an order id and the
// request dies as a uuid validation error instead of reaching the counts.
router.get('/pipeline', validate(schemas.pipeline), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.pipeline);
// The list as a CSV file, and the columns it can carry (also before
// '/:orderId'). Exporting is its own permission; the contact columns also
// need customers.reveal_sensitive (orderExportService).
router.get(
  '/export/columns',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  requirePermission(PERMISSIONS.ORDERS_EXPORT),
  validate(exportSchemas.columns),
  exportController.columns
);
router.get(
  '/export',
  requirePermission(PERMISSIONS.ORDERS_VIEW),
  requirePermission(PERMISSIONS.ORDERS_EXPORT),
  validate(exportSchemas.exportCsv),
  exportController.exportCsv
);
router.get('/:orderId', validate(schemas.get), requirePermission(PERMISSIONS.ORDERS_VIEW), controller.get);

router.post(
  '/:orderId/cancel',
  validate(schemas.cancel),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.cancel
);
// A COD order confirmed from the order page — same rules and bookkeeping as
// a queue call (modules/cod/confirmationService.js#confirmFromOrder).
router.post(
  '/:orderId/confirmation',
  validate(schemas.confirm),
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  controller.confirm
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
  requireLive,
  controller.createShipment
);
router.patch(
  '/:orderId/shipments/:shipmentId',
  validate(schemas.updateShipment),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  controller.updateShipment
);

// Shipments booked with a connected courier: pull the status now, and the
// courier's own printable label (AWB).
router.post(
  '/:orderId/shipments/:shipmentId/sync',
  validate(carrierSchemas.shipmentAction),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  carrierController.sync
);
router.get(
  '/:orderId/shipments/:shipmentId/label',
  validate(carrierSchemas.shipmentAction),
  requirePermission(PERMISSIONS.ORDERS_MANAGE),
  carrierController.label
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
