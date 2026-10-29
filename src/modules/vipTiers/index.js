'use strict';

const crypto = require('crypto');
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
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { STAGE_SQL, ORDERS_WITH_STAGE_FROM } = require('../orders/orderStage');
const { effectiveVariantPrice } = require('../catalog/productPage');
const { requireStoreFeature, storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * VIP tiers. settings.vip_tiers =
 *   { enabled, basis: 'spent' | 'orders', windowDays: null | 30–1825,
 *     tiers: [{ id, name: { ar, en }, threshold, percentOff 0–50,
 *               freeShipping, pointsMultiplier 1–5 }] }   (up to 6)
 *
 * A customer's tier comes from their DELIVERED orders (money really received):
 * what they spent (minor units) or how many orders, over the last windowDays
 * (or ever) — the highest tier whose threshold they reach. It is worked out
 * when needed, so it follows returns and cancellations by itself.
 *
 * Perks, for a signed-in shopper (shopperAccounts) only — a typed phone
 * proves nothing:
 *   percentOff      plain lines priced that much lower (the server-pinned
 *                   price marker, like price lists; the lowest price wins)
 *   freeShipping    the order ships free
 *   pointsMultiplier loyalty points earned × this (loyalty/)
 * The merchant sets every number.
 * Off (STORE_FEATURES without vip_tiers): no tier is ever reached, whatever
 * the settings hold, and the routes answer 404.
 */

const PINNED = Symbol.for('zimos.productTestPrice');
const FREE_SHIPPING = Symbol.for('zimos.freeShipping');

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.vip_tiers) || {};
  return { enabled: storeFeatureOn('vip_tiers') && Boolean(s.enabled), basis: s.basis === 'orders' ? 'orders' : 'spent', windowDays: Number.isInteger(s.windowDays) ? s.windowDays : null, tiers: Array.isArray(s.tiers) ? s.tiers : [] };
}

async function standingOf(workspaceId, customerId, windowDays) {
  const [row] = await db.sequelize.query(
    `SELECT COALESCE(SUM(x.total_amount - x.amount_refunded), 0)::bigint AS spent, COUNT(*)::int AS orders
       FROM (SELECT o.total_amount, o.amount_refunded, ${STAGE_SQL} AS stage
               FROM ${ORDERS_WITH_STAGE_FROM}
              WHERE o.workspace_id = :ws AND o.customer_id = :c AND o.is_test = false
                ${windowDays ? "AND o.created_at > NOW() - (:days * INTERVAL '1 day')" : ''}) x
      WHERE x.stage = 'delivered'`,
    { replacements: { ws: workspaceId, c: customerId, days: windowDays || 0 }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return { spent: Number(row.spent), orders: row.orders };
}

/** { tier, next, standing } for a customer; tier null below the first. */
async function tierOf(workspace, customerId) {
  const s = settingsOf(workspace);
  if (!s.enabled || !s.tiers.length || !customerId) return { tier: null, next: null, standing: null };
  const standing = await standingOf(workspace.id, customerId, s.windowDays);
  const value = s.basis === 'orders' ? standing.orders : standing.spent;
  const sorted = [...s.tiers].sort((a, b) => a.threshold - b.threshold);
  const reached = sorted.filter((t) => value >= t.threshold);
  const tier = reached.length ? reached[reached.length - 1] : null;
  const next = sorted.find((t) => value < t.threshold) || null;
  return { tier, next: next ? { id: next.id, name: next.name, missing: next.threshold - value } : null, standing: { basis: s.basis, value, ...standing } };
}

/** Checkout: the signed-in shopper's tier perks on the items (lower prices) and the order (free shipping). */
async function applyAtCheckout(workspace, items, shopper, orderBody) {
  if (!shopper) return { items, tier: null };
  const { tier } = await tierOf(workspace, shopper.id);
  if (!tier) return { items, tier: null };
  let out = items;
  if (tier.percentOff > 0) {
    // A combo's lines keep the combo's price (combos/comboPricing.js).
    const COMBO = Symbol.for('zimos.combo');
    const ids = items.filter((i) => !i.offerId && !i[COMBO] && i.variantId).map((i) => i.variantId);
    const variants = new Map((await db.ProductVariant.findAll({ where: { id: ids, workspaceId: workspace.id }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'pageSettings'] }] })).map((v) => [v.id, v]));
    out = items.map((item) => {
      const v = !item.offerId && !item[COMBO] && variants.get(item.variantId);
      if (!v) return item;
      const current = item[PINNED] !== undefined ? Number(item[PINNED]) : Number(effectiveVariantPrice(v, v.product).priceAmount);
      if (current === 0) return item; // gifts and trials stay free
      const listBase = Number(effectiveVariantPrice(v, v.product).priceAmount);
      const vip = Math.round((listBase * (100 - tier.percentOff)) / 100);
      return vip < current ? { ...item, [PINNED]: vip } : item;
    });
  }
  if (tier.freeShipping) orderBody[FREE_SHIPPING] = true;
  return { items: out, tier };
}

/** loyalty/earnForOrder: the multiplier of the order customer's tier (1 when none). */
async function pointsMultiplier(workspace, customerId) {
  const { tier } = await tierOf(workspace, customerId).catch(() => ({ tier: null }));
  return tier && tier.pointsMultiplier > 1 ? tier.pointsMultiplier : 1;
}

const publicTier = (t) => (t ? { id: t.id, name: t.name, percentOff: t.percentOff || 0, freeShipping: Boolean(t.freeShipping), pointsMultiplier: t.pointsMultiplier || 1 } : null);

// ----------------------------------------------------------------- routes --

// Mounted at /api/v1/workspaces/:workspaceId/vip-tiers.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('vip_tiers'));
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
staff.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] })))));
const name = Joi.object({ ar: Joi.string().trim().max(40).allow(''), en: Joi.string().trim().max(40).allow('') }).or('ar', 'en');
staff.put(
  '/',
  requirePermission(PERMISSIONS.DISCOUNTS_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      enabled: Joi.boolean().required(),
      basis: Joi.string().valid('spent', 'orders').required(),
      windowDays: Joi.number().integer().min(30).max(1825).allow(null),
      tiers: Joi.array().items(Joi.object({ id: Joi.string().max(40), name: name.required(), threshold: Joi.number().integer().min(1).max(1e12).required(), percentOff: Joi.number().integer().min(0).max(50).default(0), freeShipping: Joi.boolean().default(false), pointsMultiplier: Joi.number().min(1).max(5).precision(1).default(1) })).max(6).unique('threshold').required(),
    }),
  }),
  asyncHandler(async (req, res) => {
    if (req.body.enabled && !req.body.tiers.length) throw new ValidationError([{ field: 'tiers', message: 'Add at least one tier' }]);
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    const next = { ...req.body, windowDays: req.body.windowDays || null, tiers: req.body.tiers.map((t) => ({ ...t, id: t.id || crypto.randomUUID() })).sort((a, b) => a.threshold - b.threshold) };
    await workspace.update({ settings: { ...(workspace.settings || {}), vip_tiers: next } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'vip_tiers.update', entityType: 'Workspace', entityId: workspace.id, after: { enabled: next.enabled, tiers: next.tiers.length }, req });
    res.json(settingsOf(workspace));
  })
);
staff.get('/customers/:customerId', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: Joi.object({ ...ws, customerId: Joi.string().uuid().required() }) }), asyncHandler(async (req, res) => {
  const customer = await db.Customer.findOne({ where: { id: req.params.customerId, workspaceId: req.tenant.workspaceId }, attributes: ['id'] });
  if (!customer) throw new NotFoundError('Customer');
  const workspace = await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['id', 'settings'] });
  const t = await tierOf(workspace, customer.id);
  res.json({ tier: publicTier(t.tier), next: t.next, standing: t.standing });
}));

// Mounted at /api/v1/store/:workspaceId/account/vip — the signed-in shopper's tier.
const account = Router({ mergeParams: true });
account.use(requireStoreFeature('vip_tiers'));
account.get('/', resolvePublicWorkspace, validate({ params: Joi.object({ workspaceId: Joi.string().required() }) }), asyncHandler(async (req, res) => {
  const customer = await require('../shopperAccounts/shopperAuth').readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!customer) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  const workspace = await db.Workspace.findByPk(req.publicWorkspace.id, { attributes: ['id', 'settings'] });
  const s = settingsOf(workspace);
  if (!s.enabled) return res.json({ enabled: false, tier: null, next: null, tiers: [] });
  const t = await tierOf(workspace, customer.id);
  return res.json({ enabled: true, basis: s.basis, tier: publicTier(t.tier), next: t.next, standing: t.standing ? { value: t.standing.value } : null, tiers: s.tiers.map((x) => ({ ...publicTier(x), threshold: x.threshold })) });
}));

module.exports = { staff, account, tierOf, applyAtCheckout, pointsMultiplier, settingsOf, FREE_SHIPPING };
