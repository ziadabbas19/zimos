'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const svc = require('./loyaltyService');
const access = require('./loyaltyAccess');
const { requireStoreFeature } = require('../../core/middleware/storeFeatures');
const { requirePlanFeature } = require('../billing/planFeatureGate');

// Loyalty points — see loyaltyService.js. Off (STORE_FEATURES without loyalty): 404.

/** What the storefront shows about the programme (null when off). */
function publicProgram(workspace) {
  const s = svc.settingsOf(workspace);
  if (!s.enabled) return null;
  return { earnPointsPerUnit: s.earnPointsPerUnit, pointValue: s.pointValue, minRedeemPoints: s.minRedeemPoints, maxRedeemPercent: s.maxRedeemPercent, maxRedeemPointsPerOrder: s.maxRedeemPointsPerOrder, expiryDays: s.expiryDays, currency: workspace.defaultCurrency };
}

/** publicProgram, and null while the store's points are frozen (loyaltyAccess): nothing to earn or spend then. */
async function liveProgram(workspace) {
  const program = publicProgram(workspace);
  return program && (await access.frozenReason(workspace.id)) ? null : program;
}

/**
 * LOYALTY_REQUIRE_PLAN_FEATURE: switching the programme on needs the plan's
 * `loyalty` (403 PLAN_FEATURE_REQUIRED, while PLAN_FEATURE_ENFORCEMENT is on
 * too). Saving it off, or saving the numbers while off, passes on any plan.
 */
const planGate = requirePlanFeature(access.FEATURE);
const enableGate = asyncHandler(async (req, res, next) => {
  if (!access.planGateOn() || req.body.enabled !== true) return next();
  return planGate(req, res, next);
});

// Mounted at /api/v1/workspaces/:workspaceId/loyalty.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('loyalty'));
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
staff.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings', 'defaultCurrency'] });
  const [row] = await db.sequelize.query('SELECT COUNT(*) FILTER (WHERE loyalty_points > 0)::int AS members, COALESCE(SUM(loyalty_points), 0)::bigint AS outstanding FROM customers WHERE workspace_id = :ws', { replacements: { ws: workspace.id }, type: db.Sequelize.QueryTypes.SELECT });
  const s = svc.settingsOf(workspace);
  // planLocked: switching on would be refused; frozenReason: why the points can't be earned or spent now ('plan' | 'subscription').
  const [planLocked, frozenReason] = await Promise.all([access.planLocked(workspace.id), access.frozenReason(workspace.id)]);
  res.json({ settings: { ...s, enabled: Boolean(workspace.settings && workspace.settings.loyalty && workspace.settings.loyalty.enabled) }, active: s.enabled, planLocked, frozen: Boolean(frozenReason), frozenReason, currency: workspace.defaultCurrency, customersWithPoints: row.members, outstandingPoints: Number(row.outstanding), outstandingWorth: s.pointValue ? String(Number(row.outstanding) * s.pointValue) : null });
}));
staff.put(
  '/',
  requirePermission(PERMISSIONS.DISCOUNTS_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      enabled: Joi.boolean().required(),
      earnPointsPerUnit: Joi.number().min(0.01).max(1000).precision(2).when('enabled', { is: true, then: Joi.required() }).allow(null),
      pointValue: Joi.number().integer().min(1).max(1000000).when('enabled', { is: true, then: Joi.required() }).allow(null),
      minRedeemPoints: Joi.number().integer().min(1).max(10000000),
      maxRedeemPercent: Joi.number().integer().min(1).max(100),
      maxRedeemPointsPerOrder: Joi.number().integer().min(1).max(10000000).allow(null),
      expiryDays: Joi.number().integer().min(30).max(1825).allow(null),
    }),
  }),
  enableGate,
  asyncHandler(async (req, res) => {
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const before = (workspace.settings && workspace.settings.loyalty) || null;
    const next = { ...(before || {}), ...req.body };
    await workspace.update({ settings: { ...(workspace.settings || {}), loyalty: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'loyalty.settings', entityType: 'Workspace', entityId: workspace.id, before, after: next, req });
    res.json({ settings: { ...svc.settingsOf(workspace), enabled: Boolean(next.enabled) }, active: svc.settingsOf(workspace).enabled });
  })
);
const cust = Joi.object({ ...ws, customerId: Joi.string().uuid().required() });
staff.get('/customers/:customerId', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: cust }), asyncHandler(async (req, res) => {
  const customer = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId } });
  if (!customer) throw new NotFoundError('Customer');
  const workspace = await db.Workspace.findByPk(customer.workspaceId, { attributes: ['id', 'settings', 'defaultCurrency'] });
  res.json(await svc.accountOf(workspace, customer, 200));
}));
staff.post(
  '/customers/:customerId/adjust',
  requirePermission(PERMISSIONS.CUSTOMERS_MANAGE),
  validate({ params: cust, body: Joi.object({ points: Joi.number().integer().min(-10000000).max(10000000).invalid(0).required(), note: Joi.string().trim().min(1).max(200).required() }) }),
  asyncHandler(async (req, res) => {
    const out = await svc.adjust(req.tenant.workspaceId, req.params.customerId, req.body.points, req.body.note, req);
    res.json({ balance: out.balance, applied: out.applied });
  })
);

// Mounted at /api/v1/store/:workspaceId/loyalty — the programme, for the product page and checkout.
const store = Router({ mergeParams: true });
store.use(requireStoreFeature('loyalty'));
store.get('/', resolvePublicWorkspace, validate({ params: Joi.object({ workspaceId: Joi.string().required() }) }), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ program: await liveProgram(req.publicWorkspace) });
}));

// Mounted at /api/v1/store/:workspaceId/account/loyalty — the signed-in shopper's points.
const account = Router({ mergeParams: true });
account.use(requireStoreFeature('loyalty'));
account.get('/', resolvePublicWorkspace, validate({ params: Joi.object({ workspaceId: Joi.string().required() }) }), asyncHandler(async (req, res) => {
  const customer = await require('../shopperAccounts/shopperAuth').readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!customer) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  const workspace = await db.Workspace.findByPk(req.publicWorkspace.id, { attributes: ['id', 'settings', 'defaultCurrency'] });
  // Frozen: the balance and its history show, with no programme to earn or spend in.
  res.json({ program: await liveProgram(workspace), ...(await svc.accountOf(workspace, customer)) });
}));

module.exports = { staff, store, account, publicProgram, liveProgram };
