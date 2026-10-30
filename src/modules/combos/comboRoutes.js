'use strict';

const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const service = require('./comboService');
const schemas = require('./comboValidation');
const { requireGrowthFeature } = require('../billing/growthFeatures');

/*
 * Combos (PRODUCT_COMBOS_ENABLED; off, every route here answers 404).
 *
 * Staff, /api/v1/workspaces/:workspaceId/combos (products.view to read, products.manage to change):
 *   GET    /                list (archived ones with ?status=archived)
 *   POST   /                create (components sent whole)
 *   POST   /preview         what the components cost and what the combo would, for the form
 *   GET    /:comboId        one
 *   PATCH  /:comboId        update; `items`, when sent, replaces them all
 *   DELETE /:comboId        archive (orders keep its name)
 * Storefront, /api/v1/store/:workspaceId/combos?productId= — the combos a product's page shows.
 * With GROWTH_REQUIRE_PLAN_FEATURE, the plan's `combos` too (billing/growthFeatures.js):
 * without it the staff routes refuse and the storefront offers none.
 */

const gate = (req, res, next) => (env.combos.enabled ? next() : next(new NotFoundError('Combo')));
const ws = (req) => req.tenant.workspaceId;

const staff = Router({ mergeParams: true });
staff.use(gate, authenticate, resolveTenant, requireGrowthFeature('combos'));
staff.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate(schemas.list), asyncHandler(async (req, res) => res.json({ combos: await service.list(ws(req), req.query) })));
staff.post('/', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate(schemas.create), asyncHandler(async (req, res) => res.status(201).json({ combo: await service.create(ws(req), req.body, req) })));
staff.post('/preview', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate(schemas.preview), asyncHandler(async (req, res) => res.json({ preview: await service.preview(ws(req), req.body) })));
staff.get('/:comboId', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate(schemas.one), asyncHandler(async (req, res) => res.json({ combo: await service.get(ws(req), req.params.comboId) })));
staff.patch('/:comboId', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate(schemas.update), asyncHandler(async (req, res) => res.json({ combo: await service.update(ws(req), req.params.comboId, req.body, req) })));
staff.delete('/:comboId', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate(schemas.one), asyncHandler(async (req, res) => res.json(await service.archive(ws(req), req.params.comboId, req))));

// Mounted inside the storefront router (resolvePublicWorkspace already ran).
const store = Router({ mergeParams: true });
store.get(
  '/combos',
  gate,
  validate(schemas.publicList),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ combos: req.query.productId ? await service.forProduct(ws(req), req.query.productId) : [] });
  })
);

module.exports = { staff, store };
