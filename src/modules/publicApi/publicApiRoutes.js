'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const env = require('../../config/env');
const { authenticateApiKey, apiKeyLimiter, requireScope } = require('../apiKeys/apiKeyAuth');
const controller = require('./publicOrderController');
const schemas = require('./publicOrderValidation');

// Mounted at /api/v1/public. Authenticated by a workspace API key
// (modules/apiKeys), not a staff session: the key names the workspace, so
// no route here takes a workspace id. Each route checks the same permission
// its dashboard twin does; apiKeyAuth makes that check honour the key's
// scopes as well as its creator's role. Documented in docs/public-api.md.
const router = Router();
router.use(authenticateApiKey, apiKeyLimiter);

const read = requirePermission(PERMISSIONS.ORDERS_VIEW);
const manage = requirePermission(PERMISSIONS.ORDERS_MANAGE);

router.get('/me', controller.me);

// The scope by name as well: orders.manage alone does not tell an update from a cancel.
const update = requireScope('orders:update', 'orders:write');

router.get('/orders', controller.listAliases, validate(schemas.list), read, controller.list);

// Tills and kitchens behind a local network (PUBLIC_API_ACK_ENABLED): the
// accepted orders this key has not acknowledged, its receipts, and the
// order's status in the till. Off, `next('route')` lets each path answer
// exactly as it did before these routes existed. Before '/orders/:orderId'.
const ackOn = (req, res, next) => (env.publicApi.ack === true ? next() : next('route'));
router.get('/orders/accepted', ackOn, validate(schemas.accepted), read, controller.accepted);
router.post('/orders/ack', ackOn, validate(schemas.ack), read, controller.ack);
router.post('/orders/:orderId/ack', ackOn, validate(schemas.get), read, controller.ackOne);
// The scope by name: a note in the till is not an order update, and orders:write does not grant it.
router.put('/orders/:orderId/pos-status', ackOn, requireScope('orders:pos_status'), validate(schemas.posStatus), manage, controller.posStatus);
// Before '/orders/:orderId', or "by-number" would be read as an order id.
router.get('/orders/by-number/:orderNumber', validate(schemas.byNumber), read, controller.getByNumber);
router.get('/orders/:orderId', validate(schemas.get), read, controller.get);
router.get('/orders/:orderId/shipments', validate(schemas.get), read, controller.listShipments);

router.post(
  '/orders/:orderId/confirmation',
  validate(schemas.confirmation),
  update,
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  controller.confirmation
);
router.post('/orders/:orderId/cancel', requireScope('orders:delete', 'orders:write'), validate(schemas.cancel), manage, controller.cancel);
router.post('/orders/:orderId/shipments', update, validate(schemas.createShipment), manage, controller.createShipment);
router.patch('/orders/:orderId/shipments/:shipmentId', update, validate(schemas.updateShipment), manage, controller.updateShipment);
router.post('/orders/:orderId/cod-collected', update, validate(schemas.get), manage, controller.codCollected);

// Products, categories, customers, discounts, shipping areas, webhooks, and
// creating orders / notes / tracking (SPEC §16.2).
router.use(require('./publicResourceRoutes'));

module.exports = router;
