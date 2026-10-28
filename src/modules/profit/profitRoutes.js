'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const pnl = require('./pnlService');
const economics = require('./economicsService');
const adSpend = require('./adSpendService');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };
const range = { from: Joi.date().iso(), to: Joi.date().iso() };
const money = Joi.number().integer().min(0).max(1e12);
const bp = Joi.number().integer().min(0).max(10000);
const economicsBody = Joi.object({
  packagingCostAmount: money.allow(null),
  shippingCostAmount: money.allow(null),
  returnCostAmount: money.allow(null),
  collectionFeeBp: bp.allow(null),
  gatewayFeeBp: bp.allow(null),
  damageBp: bp.allow(null),
}).min(1);
const dayString = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const count = Joi.number().integer().min(0).max(2e9).allow(null);

const READ = requirePermission(PERMISSIONS.FINANCIAL_REPORTS_VIEW);
const WRITE = requirePermission(PERMISSIONS.PROFIT_MANAGE);

// Mounted at /api/v1/workspaces/:workspaceId/profit
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

router.get(
  '/pnl',
  READ,
  validate({ params: Joi.object(ws), query: Joi.object({ ...range, groupBy: Joi.string().valid(...pnl.GROUPS) }) }),
  asyncHandler(async (req, res) => res.json({ pnl: await pnl.getPnl(req.tenant.workspaceId, req.query) }))
);

// --- product economics ---
router.get(
  '/economics',
  READ,
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json(await economics.list(req.tenant.workspaceId)))
);
router.put(
  '/economics/defaults',
  WRITE,
  validate({ params: Joi.object(ws), body: economicsBody }),
  asyncHandler(async (req, res) => res.json({ defaults: await economics.upsert(req.tenant.workspaceId, null, req.body, req) }))
);
router.put(
  '/economics/products/:productId',
  WRITE,
  validate({ params: Joi.object({ ...ws, productId: uuid.required() }), body: economicsBody }),
  asyncHandler(async (req, res) =>
    res.json({ overrides: await economics.upsert(req.tenant.workspaceId, req.params.productId, req.body, req) })
  )
);
router.delete(
  '/economics/products/:productId',
  WRITE,
  validate({ params: Joi.object({ ...ws, productId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json(await economics.remove(req.tenant.workspaceId, req.params.productId, req)))
);

// --- ad spend ---
router.get(
  '/ad-spend',
  READ,
  validate({
    params: Joi.object(ws),
    query: Joi.object({
      from: dayString,
      to: dayString,
      platform: Joi.string().valid(...adSpend.PLATFORMS),
      limit: Joi.number().integer().min(1).max(500).default(200),
      offset: Joi.number().integer().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await adSpend.list(req.tenant.workspaceId, req.query)))
);
router.post(
  '/ad-spend',
  WRITE,
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      day: dayString.required(),
      platform: Joi.string().valid(...adSpend.PLATFORMS).required(),
      campaignName: Joi.string().trim().min(1).max(200).required(),
      campaignId: Joi.string().trim().max(100).allow('', null),
      spendAmount: money.required(),
      impressions: count,
      clicks: count,
    }),
  }),
  asyncHandler(async (req, res) => res.status(201).json({ entry: await adSpend.create(req.tenant.workspaceId, req.body, req) }))
);
router.post(
  '/ad-spend/import',
  WRITE,
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      csv: Joi.string().min(1).max(1500000).required(),
      defaultPlatform: Joi.string().valid(...adSpend.PLATFORMS),
      dryRun: Joi.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => res.json({ import: await adSpend.importCsv(req.tenant.workspaceId, req.body, req) }))
);
router.patch(
  '/ad-spend/:entryId',
  WRITE,
  validate({
    params: Joi.object({ ...ws, entryId: uuid.required() }),
    body: Joi.object({
      spendAmount: money,
      impressions: count,
      clicks: count,
      campaignId: Joi.string().trim().max(100).allow('', null),
    }).min(1),
  }),
  asyncHandler(async (req, res) => res.json({ entry: await adSpend.update(req.tenant.workspaceId, req.params.entryId, req.body, req) }))
);
router.delete(
  '/ad-spend/:entryId',
  WRITE,
  validate({ params: Joi.object({ ...ws, entryId: uuid.required() }) }),
  asyncHandler(async (req, res) => res.json(await adSpend.remove(req.tenant.workspaceId, req.params.entryId, req)))
);

// --- campaigns ---
// Spend comes in by hand or from a CSV (/ad-spend, /ad-spend/import); nothing
// pulls it from the ad platforms.
router.get(
  '/campaigns',
  READ,
  validate({ params: Joi.object(ws), query: Joi.object(range) }),
  asyncHandler(async (req, res) => res.json(await adSpend.campaigns(req.tenant.workspaceId, req.query)))
);

module.exports = router;
