'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { idempotent } = require('../../core/middleware/idempotency');
const { requireLive, requireCreationAllowed } = require('../../core/middleware/subscriptionGuard');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, AppError } = require('../../core/errors/AppError');
const { requireScope } = require('../apiKeys/apiKeyAuth');

const orderController = require('../orders/orderController');
const orderSchemas = require('../orders/orderValidation');
const catalogController = require('../catalog/catalogController');
const catalogSchemas = require('../catalog/catalogValidation');
const catalogService = require('../catalog/catalogService');
const customerController = require('../customers/customerController');
const customerSchemas = require('../customers/customerValidation');
const discountController = require('../discounts/discountController');
const discountSchemas = require('../discounts/discountValidation');
const shippingService = require('../shipping/shippingService');
const shippingSchemas = require('../shipping/shippingValidation');
const webhookController = require('../webhooks/webhookController');
const webhookSchemas = require('../webhooks/webhookValidation');
const analyticsController = require('../analytics/analyticsController');
const analyticsSchemas = require('../analytics/analyticsValidation');
const inventoryService = require('../inventory/inventoryService');
const { recordAudit } = require('../audit/auditService');
const { serializeOrder, serializeShipment } = require('./publicOrderSerializer');
const orderService = require('../orders/orderService');

/**
 * The rest of the public API (SPEC §16.2): products, categories, customers,
 * discounts, shipping areas, webhooks, and the order writes an integration
 * needs (create, status, notes, tracking).
 *
 * Every route runs the dashboard's own validation schema and controller, so
 * the API can never accept or do something the dashboard would not. Two
 * things are added in front:
 *
 *  - `ws`: the dashboard schemas expect `:workspaceId` in the path; here the
 *    workspace is the key's, so it is filled in from req.tenant.
 *  - `requireScope`: role permissions do not tell create from delete, the
 *    key's scopes do (apiKeyService.SCOPES).
 *
 * Mounted by publicApiRoutes.js after authenticateApiKey + the key limiter.
 */

const router = Router();

const ws = (req, res, next) => {
  req.params.workspaceId = req.tenant.workspaceId;
  next();
};
const can = (permission) => requirePermission(permission);
const uuid = Joi.string().uuid();

// ───────────────────────────── orders ─────────────────────────────

const ORDER_WRITE = 'orders:write'; // the original all-in-one write scope

// A draft store takes no orders; a repeated Idempotency-Key returns the first answer.
router.post(
  '/orders',
  requireScope('orders:create', ORDER_WRITE),
  ws,
  validate(orderSchemas.create),
  can(PERMISSIONS.ORDERS_MANAGE),
  requireLive,
  idempotent('order.create')(
    asyncHandler(async (req, res) => {
      const { order } = await orderService.createOrder(req.tenant.workspaceId, req.body, req);
      res.status(201).json({ order: serializeOrder(await orderService.getOrder(req.tenant.workspaceId, order.id)) });
    })
  )
);

router.patch(
  '/orders/:orderId/status',
  requireScope('orders:update', ORDER_WRITE),
  ws,
  validate(orderSchemas.changeStatus),
  can(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => {
    // eslint-disable-next-line global-require
    const stageChange = require('../orders/orderStageChange');
    await stageChange.changeStage(req.tenant.workspaceId, req.params.orderId, req.body, req);
    res.json({ order: serializeOrder(await orderService.getOrder(req.tenant.workspaceId, req.params.orderId)) });
  })
);

router.get('/orders/:orderId/notes', requireScope('orders:read', ORDER_WRITE), ws, validate(orderSchemas.get), can(PERMISSIONS.ORDERS_VIEW), orderController.listNotes);
router.post(
  '/orders/:orderId/notes',
  requireScope('orders:update', ORDER_WRITE),
  ws,
  validate(orderSchemas.addNote),
  can(PERMISSIONS.ORDERS_MANAGE),
  orderController.addNote
);

// "Add tracking": the waybill an outside fulfilment system booked. Same as POST /orders/:id/shipments.
router.post(
  '/orders/:orderId/tracking',
  requireScope('orders:update', ORDER_WRITE),
  ws,
  validate(orderSchemas.createShipment),
  can(PERMISSIONS.ORDERS_MANAGE),
  asyncHandler(async (req, res) => {
    const shipment = await orderService.createShipment(req.tenant.workspaceId, req.params.orderId, req.body, req);
    res.status(201).json({ shipment: serializeShipment(shipment) });
  })
);

// ───────────────────────────── products ─────────────────────────────

const view = can(PERMISSIONS.PRODUCTS_VIEW);
const manage = can(PERMISSIONS.PRODUCTS_MANAGE);

router.get('/products', requireScope('products:read'), ws, validate(catalogSchemas.productList), view, catalogController.listProducts);
router.post(
  '/products',
  requireScope('products:create'),
  ws,
  validate(catalogSchemas.product),
  manage,
  requireCreationAllowed,
  catalogController.createProduct
);

/**
 * PATCH /products/sku/:sku/stock — { stock: 25 } sets the count on hand,
 * { delta: -3 } moves it. For warehouse and supplier systems that only know
 * the SKU. Before '/products/:productId' so "sku" is not read as an id.
 */
router.patch(
  '/products/sku/:sku/stock',
  requireScope('products:update'),
  validate({
    params: Joi.object({ sku: Joi.string().trim().min(1).max(100).required() }),
    body: Joi.object({
      stock: Joi.number().integer().min(0),
      delta: Joi.number().integer(),
      reason: Joi.string().trim().max(200).optional(),
    }).xor('stock', 'delta'),
  }),
  can(PERMISSIONS.INVENTORY_MANAGE),
  asyncHandler(async (req, res) => {
    const workspaceId = req.tenant.workspaceId;
    const variants = await db.ProductVariant.findAll({ where: { workspaceId, sku: req.params.sku }, limit: 2 });
    if (variants.length === 0) throw new NotFoundError('Variant');
    if (variants.length > 1) throw new AppError('SKU_NOT_UNIQUE', 'More than one variant has this SKU; use its variant id in the dashboard', 409);
    const [variant] = variants;
    const before = variant.stockOnHand;
    const delta = req.body.delta !== undefined ? req.body.delta : req.body.stock - before;
    const updated =
      delta === 0
        ? variant
        : await inventoryService.adjustStock({
            workspaceId,
            variantId: variant.id,
            delta,
            reason: req.body.reason || `API key ${req.apiKey.keyPrefix}`,
            actorUserId: req.user.id,
          });
    if (delta !== 0) {
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'inventory.adjust',
        entityType: 'ProductVariant',
        entityId: variant.id,
        before: { stockOnHand: before },
        after: { stockOnHand: updated.stockOnHand, via: 'public_api' },
        req,
      });
    }
    res.json({
      variant: {
        id: updated.id,
        productId: updated.productId,
        sku: updated.sku,
        stockOnHand: updated.stockOnHand,
        reservedStock: updated.reservedStock,
        available: updated.stockOnHand - updated.reservedStock,
      },
    });
  })
);

router.get('/products/:productId', requireScope('products:read'), ws, validate(catalogSchemas.productGet), view, catalogController.getProduct);
router.patch('/products/:productId', requireScope('products:update'), ws, validate(catalogSchemas.productUpdate), manage, catalogController.updateProduct);
// Archives the product (restorable from the dashboard), like the dashboard's delete.
router.delete('/products/:productId', requireScope('products:delete'), ws, validate(catalogSchemas.productDelete), manage, catalogController.deleteProduct);

// ───────────────────────────── categories ─────────────────────────────
// The dashboard calls them collections; integrations coming from other
// platforms call them categories.

const category = (handler) => asyncHandler(async (req, res) => res.status(handler.status || 200).json(await handler.run(req)));
const wid = (req) => req.tenant.workspaceId;

router.get(
  '/categories',
  requireScope('categories:read'),
  view,
  category({ run: async (req) => ({ categories: await catalogService.listCollections(wid(req)) }) })
);
router.post(
  '/categories',
  requireScope('categories:create'),
  ws,
  validate(catalogSchemas.collection),
  manage,
  category({ status: 201, run: async (req) => ({ category: await catalogService.createCollection(wid(req), req.body, req) }) })
);
router.get(
  '/categories/:collectionId',
  requireScope('categories:read'),
  ws,
  validate(catalogSchemas.collectionGet),
  view,
  category({ run: async (req) => ({ category: await catalogService.getCollection(wid(req), req.params.collectionId) }) })
);
router.patch(
  '/categories/:collectionId',
  requireScope('categories:update'),
  ws,
  validate(catalogSchemas.collectionUpdate),
  manage,
  category({ run: async (req) => ({ category: await catalogService.updateCollection(wid(req), req.params.collectionId, req.body, req) }) })
);
router.delete(
  '/categories/:collectionId',
  requireScope('categories:delete'),
  ws,
  validate(catalogSchemas.collectionDelete),
  manage,
  category({ run: (req) => catalogService.deleteCollection(wid(req), req.params.collectionId, req) })
);

// ───────────────────────────── customers ─────────────────────────────

router.get('/customers', requireScope('customers:read'), ws, validate(customerSchemas.list), can(PERMISSIONS.CUSTOMERS_VIEW), customerController.list);
router.get('/customers/:customerId', requireScope('customers:read'), ws, validate(customerSchemas.get), can(PERMISSIONS.CUSTOMERS_VIEW), customerController.get);

// ───────────────────────────── discounts ─────────────────────────────

const discounts = can(PERMISSIONS.DISCOUNTS_MANAGE);
router.get('/discounts', requireScope('discounts:read', 'discounts:write'), ws, validate(discountSchemas.list), discounts, discountController.list);
router.post('/discounts', requireScope('discounts:write'), ws, validate(discountSchemas.create), discounts, discountController.create);
router.get('/discounts/:discountId', requireScope('discounts:read', 'discounts:write'), ws, validate(discountSchemas.get), discounts, discountController.get);
router.patch('/discounts/:discountId', requireScope('discounts:write'), ws, validate(discountSchemas.update), discounts, discountController.update);
router.delete('/discounts/:discountId', requireScope('discounts:write'), ws, validate(discountSchemas.remove), discounts, discountController.remove);

// ───────────────────────────── shipping areas ─────────────────────────────
// A shipping area is a zone (the governorates it covers) with its prices (rates).

const shipping = can(PERMISSIONS.SHIPPING_MANAGE);
const rateBody = shippingSchemas.updateRate.body;

router.get(
  '/shipping-areas',
  requireScope('shipping_areas:read', 'shipping_areas:write'),
  shipping,
  asyncHandler(async (req, res) => res.json({ shippingAreas: await shippingService.listZones(wid(req)) }))
);

/**
 * PATCH /shipping-areas — many prices in one call:
 *   { "rates": [{ "rateId": "…", "amount": 6500 }, { "rateId": "…", "isActive": false }] }
 * Each entry takes the fields of the dashboard's rate form. All or nothing:
 * the ids are checked first, then every rate is updated.
 */
router.patch(
  '/shipping-areas',
  requireScope('shipping_areas:write'),
  validate({
    body: Joi.object({
      rates: Joi.array()
        .items(Joi.object({ rateId: uuid.required() }).unknown(true))
        .min(1)
        .max(200)
        .required(),
    }),
  }),
  shipping,
  asyncHandler(async (req, res) => {
    const workspaceId = wid(req);
    const updates = [];
    const errors = [];
    req.body.rates.forEach(({ rateId, ...fields }, index) => {
      const { error, value } = rateBody.validate(fields, { abortEarly: false, stripUnknown: true });
      if (error) errors.push(...error.details.map((d) => ({ field: `rates.${index}.${d.path.join('.')}`, message: d.message })));
      else updates.push({ rateId, value });
    });
    const known = await db.ShippingRate.findAll({ where: { workspaceId, id: req.body.rates.map((r) => r.rateId) }, attributes: ['id'] });
    const knownIds = new Set(known.map((r) => r.id));
    req.body.rates.forEach(({ rateId }, index) => {
      if (!knownIds.has(rateId)) errors.push({ field: `rates.${index}.rateId`, message: 'No shipping rate with this id' });
    });
    if (errors.length > 0) {
      // eslint-disable-next-line global-require
      const { ValidationError } = require('../../core/errors/AppError');
      throw new ValidationError(errors, 'Invalid body');
    }
    const rates = [];
    for (const { rateId, value } of updates) rates.push(await shippingService.updateRate(workspaceId, rateId, value, req));
    res.json({ rates });
  })
);

// ───────────────────────────── webhooks ─────────────────────────────

const hooks = can(PERMISSIONS.WEBHOOKS_MANAGE);
const hookScope = requireScope('webhooks:write');
router.get('/webhooks/events', hookScope, ws, validate(webhookSchemas.list), hooks, webhookController.events);
router.get('/webhooks', hookScope, ws, validate(webhookSchemas.list), hooks, webhookController.list);
// The signing secret is in this answer and never shown again.
// WEBHOOKS_REQUIRE_API_ACCESS: as in the dashboard, a new endpoint needs api_access.
router.post('/webhooks', hookScope, ws, validate(webhookSchemas.create), hooks, require('../webhooks/webhookPlanGate').newEndpointGate, webhookController.create);
router.patch('/webhooks/:endpointId', hookScope, ws, validate(webhookSchemas.update), hooks, webhookController.update);
router.delete('/webhooks/:endpointId', hookScope, ws, validate(webhookSchemas.byId), hooks, webhookController.remove);

// ───────────────────────────── analytics ─────────────────────────────

router.get(
  '/analytics/summary',
  requireScope('analytics:read'),
  ws,
  validate(analyticsSchemas.summary),
  can(PERMISSIONS.ANALYTICS_VIEW),
  analyticsController.summary
);

module.exports = router;
