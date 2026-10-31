'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { requireStoreFeature } = require('../../core/middleware/storeFeatures');

/*
 * Size charts. A chart is a table: column headings in
 * Arabic and English, rows of cells (text, so "S", "38–40" and "96" all fit),
 * the unit its numbers are in (cm / inch), an optional note and picture.
 * It is attached to products and/or collections. The product page asks for
 * its product's chart: one attached to the product itself wins, else one on
 * a collection the product is in (the newest). The storefront converts
 * numbers between cm and inch for the shopper (×/÷ 2.54); the server keeps
 * them as entered.
 */

const label = Joi.object({ ar: Joi.string().trim().max(60).allow(''), en: Joi.string().trim().max(60).allow('') }).or('ar', 'en');
const body = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  unit: Joi.string().valid('cm', 'inch').default('cm'),
  columns: Joi.array().items(label).min(1).max(12).required(),
  rows: Joi.array().items(Joi.array().items(Joi.string().trim().max(40).allow('')).min(1).max(12)).min(1).max(40).required(),
  note: Joi.object({ ar: Joi.string().trim().max(500).allow(''), en: Joi.string().trim().max(500).allow('') }).allow(null),
  imageUrl: Joi.string().trim().uri({ scheme: ['https'] }).max(1000).allow(null, ''),
  productIds: Joi.array().items(Joi.string().uuid()).max(500).unique().default([]),
  collectionIds: Joi.array().items(Joi.string().uuid()).max(100).unique().default([]),
});

const view = (c) => ({ id: c.id, name: c.name, unit: c.unit, columns: c.columns, rows: c.rows, note: c.note, imageUrl: c.imageUrl, productIds: c.productIds, collectionIds: c.collectionIds, updatedAt: c.updatedAt });
const publicView = (c) => ({ id: c.id, name: c.name, unit: c.unit, columns: c.columns, rows: c.rows, note: c.note, imageUrl: c.imageUrl });

async function check(workspaceId, b) {
  if (b.rows.some((r) => r.length !== b.columns.length)) throw new ValidationError([{ field: 'rows', message: 'Every row needs one cell per column' }]);
  if (b.productIds.length && (await db.Product.count({ where: { id: b.productIds, workspaceId } })) !== b.productIds.length) throw new ValidationError([{ field: 'productIds', message: 'A product is not in this store' }]);
  if (b.collectionIds.length && (await db.Collection.count({ where: { id: b.collectionIds, workspaceId } })) !== b.collectionIds.length) throw new ValidationError([{ field: 'collectionIds', message: 'A collection is not in this store' }]);
}

/** The chart for a product: its own, else its collections' (newest), else null. */
async function forProduct(workspaceId, productId) {
  const own = await db.SizeChart.findOne({ where: { workspaceId, productIds: { [Op.contains]: [productId] } }, order: [['updatedAt', 'DESC']] });
  if (own) return own;
  const links = await db.ProductCollection.findAll({ where: { productId }, attributes: ['collectionId'] });
  if (!links.length) return null;
  return db.SizeChart.findOne({ where: { workspaceId, collectionIds: { [Op.overlap]: links.map((l) => l.collectionId) } }, order: [['updatedAt', 'DESC']] });
}

// Mounted at /api/v1/workspaces/:workspaceId/size-charts.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('size_charts'));
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const one = Joi.object({ ...ws, chartId: Joi.string().uuid().required() });
staff.get('/', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  res.json({ sizeCharts: (await db.SizeChart.findAll({ where: { workspaceId: req.tenant.workspaceId }, order: [['name', 'ASC']] })).map(view) });
}));
staff.post('/', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: Joi.object(ws), body }), asyncHandler(async (req, res) => {
  await check(req.tenant.workspaceId, req.body);
  const c = await db.SizeChart.create({ workspaceId: req.tenant.workspaceId, ...req.body, imageUrl: req.body.imageUrl || null });
  await recordAudit({ workspaceId: c.workspaceId, actorUserId: req.user.id, action: 'size_chart.create', entityType: 'SizeChart', entityId: c.id, after: { name: c.name }, req });
  res.status(201).json(view(c));
}));
staff.get('/:chartId', requirePermission(PERMISSIONS.PRODUCTS_VIEW), validate({ params: one }), asyncHandler(async (req, res) => {
  const c = await db.SizeChart.findOne({ where: { id: req.params.chartId, workspaceId: req.tenant.workspaceId } });
  if (!c) throw new NotFoundError('Size chart');
  res.json(view(c));
}));
staff.put('/:chartId', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: one, body }), asyncHandler(async (req, res) => {
  const c = await db.SizeChart.findOne({ where: { id: req.params.chartId, workspaceId: req.tenant.workspaceId } });
  if (!c) throw new NotFoundError('Size chart');
  await check(req.tenant.workspaceId, req.body);
  await c.update({ ...req.body, imageUrl: req.body.imageUrl || null });
  // Not audited: the store's pages are dropped here (storefrontCache.js, the edge included).
  require('../storefront/storefrontCache').invalidate(c.workspaceId);
  res.json(view(c));
}));
staff.delete('/:chartId', requirePermission(PERMISSIONS.PRODUCTS_MANAGE), validate({ params: one }), asyncHandler(async (req, res) => {
  const n = await db.SizeChart.destroy({ where: { id: req.params.chartId, workspaceId: req.tenant.workspaceId } });
  if (!n) throw new NotFoundError('Size chart');
  require('../storefront/storefrontCache').invalidate(req.tenant.workspaceId);
  res.status(204).end();
}));

// Mounted at /api/v1/store/:workspaceId/size-chart?productId=
const store = Router({ mergeParams: true });
store.use(requireStoreFeature('size_charts'));
store.get('/', resolvePublicWorkspace, validate({ params: Joi.object({ workspaceId: Joi.string().required() }), query: Joi.object({ productId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  const c = await forProduct(req.publicWorkspace.id, req.query.productId);
  res.json({ sizeChart: c ? publicView(c) : null });
}));

module.exports = { staff, store, forProduct };
