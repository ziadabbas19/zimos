'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requireCreationAllowed } = require('../../core/middleware/subscriptionGuard');
const { productBulkDeleteLimiter } = require('../../core/middleware/rateLimiters');
const catalogService = require('./catalogService');
const { productListFilters } = require('./catalogValidation');
const bulk = require('./catalogBulk');

/*
 * Bulk catalog routes (SPEC §7.10). Mounted by catalogRoutes after its
 * authenticate + resolveTenant, ahead of the `/products/:productId` routes so
 * `/products/bulk` is never read as a product id.
 */

const router = Router({ mergeParams: true });
const canView = requirePermission(PERMISSIONS.PRODUCTS_VIEW);
const canManage = requirePermission(PERMISSIONS.PRODUCTS_MANAGE);

// Import and export (importExport/routes.js): /products/export.json, /products/import, /imports.
router.use(require('./importExport/routes'));

const uuid = Joi.string().uuid();
const money = Joi.number().integer().min(0).max(100000000000);

const schemas = {
  bulkEdit: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      productIds: Joi.array().items(uuid.required()).min(1).max(200).unique().required(),
      changes: Joi.object({
        status: Joi.string().valid('draft', 'active', 'archived'),
        // 'extra_fee' needs an amount per product, so it is not a bulk choice.
        shippingMode: Joi.string().valid('standard', 'free'),
        collection: Joi.object({ id: uuid.required(), action: Joi.string().valid('add', 'remove').default('add') }),
        price: Joi.alternatives().try(
          Joi.object({ mode: Joi.string().valid('set').required(), value: money.required() }),
          Joi.object({
            mode: Joi.string().valid('increase_percent', 'decrease_percent').required(),
            value: Joi.number().min(0.01).max(1000).required(),
          })
        ),
      })
        .min(1)
        .required(),
    }),
  },
  productCount: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object(productListFilters),
  },
  // The ticked products, or every product the list's filters match (a chunk
  // per request, `cursor` from the previous answer); never both.
  bulkDelete: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      mode: Joi.string().valid('archive', 'permanent').required(),
      productIds: Joi.array().items(uuid.required()).min(1).max(bulk.BULK_DELETE_CHUNK).unique(),
      filter: Joi.object({ ...productListFilters, createdBefore: Joi.date().iso().required() }),
      cursor: uuid,
    })
      .xor('productIds', 'filter')
      .without('productIds', 'cursor')
      .required(),
  },
  duplicate: {
    params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
    body: Joi.object({ name: Joi.string().trim().min(1).max(300) }).default({}),
  },
  variantsBulk: {
    params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
    body: Joi.object({
      variants: Joi.array()
        .items(
          Joi.object({
            id: uuid.required(),
            sku: Joi.string().max(100).allow(null, ''),
            barcode: Joi.string().max(100).allow(null, ''),
            priceAmount: money,
            compareAtAmount: money.allow(null),
            costAmount: money.allow(null),
            stockOnHand: Joi.number().integer().min(0).max(100000000),
            allowOverselling: Joi.boolean(),
            status: Joi.string().valid('active', 'archived'),
            // The variant's own picture (SPEC §7.2).
            imageUrl: Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(1000).allow('', null),
          }).min(2)
        )
        .min(1)
        .max(500)
        .unique('id')
        .required(),
    }),
  },
};

router.post(
  '/products/bulk',
  validate(schemas.bulkEdit),
  canManage,
  asyncHandler(async (req, res) => {
    res.json(await bulk.bulkEditProducts(req.tenant.workspaceId, req.body, req));
  })
);

// How many products the list's filters match across every page, and `asOf`,
// the cut-off a bulk delete of all of them sends back as filter.createdBefore.
router.get(
  '/products/count',
  validate(schemas.productCount),
  canView,
  asyncHandler(async (req, res) => {
    res.json(await catalogService.countProducts(req.tenant.workspaceId, req.query));
  })
);

// Archive or delete for good, by the single delete's rules: one chunk per
// request, 200 { mode, deleted, skipped: [{ id, name, reason }], nextCursor }.
router.post(
  '/products/bulk-delete',
  validate(schemas.bulkDelete),
  canManage,
  productBulkDeleteLimiter,
  asyncHandler(async (req, res) => {
    res.json(await bulk.bulkDeleteProducts(req.tenant.workspaceId, req.body, req));
  })
);

router.post(
  '/products/:productId/duplicate',
  validate(schemas.duplicate),
  canManage,
  requireCreationAllowed,
  asyncHandler(async (req, res) => {
    const created = await bulk.duplicateProduct(req.tenant.workspaceId, req.params.productId, req, {
      slugFor: catalogService.slugFor,
      generateProductCode: catalogService.generateProductCode,
      name: req.body.name,
    });
    const product = await catalogService.getProduct(req.tenant.workspaceId, created.id);
    res.status(201).json({ product });
  })
);

router.patch(
  '/products/:productId/variants/bulk',
  validate(schemas.variantsBulk),
  canManage,
  asyncHandler(async (req, res) => {
    res.json(await bulk.bulkUpdateVariants(req.tenant.workspaceId, req.params.productId, req.body.variants, req));
  })
);

module.exports = router;
