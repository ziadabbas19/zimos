'use strict';

const crypto = require('crypto');
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
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');
const { effectiveVariantPrice } = require('../catalog/productPage');
const logger = require('../../core/utils/logger');
const { requireStoreFeature, storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * Customer referral program. settings.customer_referrals =
 *   { enabled,
 *     friend:   { percentOff: 0–50, freeShipping },          // on the friend's first order
 *     referrer: { type: 'store_credit' | 'points', amount },  // minor units, or points
 *     minOrderAmount | null,          // the friend's order total that earns the reward
 *     maxRewardsPerReferrer | null }  // rewarded friends per shopper
 *
 * A signed-in shopper gets a code and a link (`?ref=CODE`). A friend who
 * checks out with `referralCode` gets the friend offer, only on their first
 * order in the store (no earlier order on that phone, cancelled ones aside)
 * and never on the referrer's own phone, email or account. The referrer is
 * rewarded once that order is DELIVERED (order.delivered); a cancelled or
 * returned order voids it. Every number is the merchant's.
 * Off (STORE_FEATURES without customer_referrals): the program is off
 * whatever the settings hold; a code at checkout is ignored.
 */

const PINNED = Symbol.for('zimos.productTestPrice');
const FREE_SHIPPING = Symbol.for('zimos.freeShipping');

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.customer_referrals) || {};
  return {
    enabled: storeFeatureOn('customer_referrals') && Boolean(s.enabled),
    friend: { percentOff: (s.friend && s.friend.percentOff) || 0, freeShipping: Boolean(s.friend && s.friend.freeShipping) },
    referrer: { type: (s.referrer && s.referrer.type) === 'points' ? 'points' : 'store_credit', amount: (s.referrer && s.referrer.amount) || 0 },
    minOrderAmount: s.minOrderAmount || null,
    maxRewardsPerReferrer: s.maxRewardsPerReferrer || null,
  };
}

const publicOffer = (s) => ({ friend: s.friend, referrer: s.referrer, minOrderAmount: s.minOrderAmount == null ? null : String(s.minOrderAmount) });

/** The shopper's code, made the first time it is asked for. */
async function codeFor(workspaceId, customerId) {
  const existing = await db.CustomerReferralCode.findOne({ where: { workspaceId, customerId } });
  if (existing) return existing;
  for (let i = 0; i < 5; i += 1) {
    const code = crypto.randomBytes(5).toString('base64').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 7);
    if (code.length < 6) continue;
    try {
      return await db.CustomerReferralCode.create({ workspaceId, customerId, code });
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      const mine = await db.CustomerReferralCode.findOne({ where: { workspaceId, customerId } });
      if (mine) return mine;
    }
  }
  throw new AppError('REFERRAL_CODE_FAILED', 'Try again', 503);
}

async function findCode(workspaceId, code) {
  if (!code) return null;
  return db.CustomerReferralCode.findOne({ where: { workspaceId, code: String(code).trim().toUpperCase() } });
}

const refuse = (message) => new ValidationError([{ field: 'referralCode', message }], 'Invalid body');

/**
 * Checkout, before the order: checks the invite and puts the friend offer on
 * the items / order. Returns { referrerId, offer } or null (no code given).
 */
async function applyAtCheckout(workspace, items, code, orderBody, shopper) {
  if (!code) return { items, referral: null };
  const s = settingsOf(workspace);
  if (!s.enabled) throw refuse('This store has no invite program');
  const row = await findCode(workspace.id, code);
  if (!row) throw refuse('This invite code is not valid');
  const referrer = await db.Customer.findByPk(row.customerId, { attributes: ['id', 'phoneNormalized', 'email'] });
  if (!referrer) throw refuse('This invite code is not valid');

  const contact = orderBody.contact || {};
  const phone = normalizePhone(String(contact.phone || ''));
  const email = contact.email ? String(contact.email).trim().toLowerCase() : null;
  const self = (shopper && shopper.id === referrer.id)
    || (phone && phone === referrer.phoneNormalized)
    || (email && referrer.email && email === referrer.email.trim().toLowerCase());
  if (self) throw refuse('You can\'t use your own invite');

  // A first order only: no earlier order (not cancelled) on this phone.
  if (phone) {
    const earlier = await db.Order.count({
      where: { workspaceId: workspace.id, cancelledAt: null, isTest: false },
      include: [{ model: db.Customer, as: 'customer', attributes: [], where: { phoneNormalized: phone } }],
    });
    if (earlier) throw refuse('Invites are for a first order in this store');
  }

  let out = items;
  if (s.friend.percentOff > 0) {
    const ids = items.filter((i) => !i.offerId && i.variantId).map((i) => i.variantId);
    const variants = new Map((await db.ProductVariant.findAll({ where: { id: ids, workspaceId: workspace.id }, include: [{ model: db.Product, as: 'product', attributes: ['id', 'pageSettings'] }] })).map((v) => [v.id, v]));
    out = items.map((item) => {
      const v = !item.offerId && variants.get(item.variantId);
      if (!v) return item;
      const current = item[PINNED] !== undefined ? Number(item[PINNED]) : Number(effectiveVariantPrice(v, v.product).priceAmount);
      if (current === 0) return item;
      const listBase = Number(effectiveVariantPrice(v, v.product).priceAmount);
      const price = Math.round((listBase * (100 - s.friend.percentOff)) / 100);
      return price < current ? { ...item, [PINNED]: price } : item;
    });
  }
  if (s.friend.freeShipping) orderBody[FREE_SHIPPING] = true;
  return { items: out, referral: { referrerId: referrer.id, offer: s.friend } };
}

/** After the order exists: the invite is recorded, waiting for delivery. Never throws. */
async function recordOnOrder(order, referral) {
  if (!referral) return;
  try {
    if (order.customerId === referral.referrerId) return;
    await db.CustomerReferral.create({ workspaceId: order.workspaceId, referrerCustomerId: referral.referrerId, friendCustomerId: order.customerId, orderId: order.id, friendOffer: referral.offer });
    const fresh = await db.Order.findByPk(order.id, { attributes: ['id', 'tags'] });
    await fresh.update({ tags: [...new Set([...(fresh.tags || []), 'referral'])] }, { hooks: false });
  } catch (err) {
    logger.warn(`[customerReferrals] could not record the invite on ${order.id}: ${err.message}`);
  }
}

// ----------------------------------------------------------------- events --

async function onDelivered(event) {
  const p = event.payload || {};
  if (!p.orderId) return null;
  await db.sequelize.transaction(async (transaction) => {
    const ref = await db.CustomerReferral.findOne({ where: { orderId: p.orderId, status: 'pending' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!ref) return;
    const order = await db.Order.findByPk(ref.orderId, { transaction });
    const workspace = await db.Workspace.findByPk(ref.workspaceId, { attributes: ['id', 'settings', 'defaultCurrency'], transaction });
    const s = settingsOf(workspace);
    const voidAs = (reason) => ref.update({ status: 'void', voidReason: reason }, { transaction });
    if (!order || order.cancelledAt || order.isTest) return voidAs('cancelled');
    if (!s.enabled || !(s.referrer.amount > 0)) return voidAs('program_off');
    if (s.minOrderAmount && Number(order.totalAmount) - Number(order.amountRefunded) < Number(s.minOrderAmount)) return voidAs('below_minimum');
    if (s.maxRewardsPerReferrer) {
      const given = await db.CustomerReferral.count({ where: { referrerCustomerId: ref.referrerCustomerId, status: 'rewarded' }, transaction });
      if (given >= s.maxRewardsPerReferrer) return voidAs('limit_reached');
    }
    const note = `Invite: ${order.orderNumber}`.slice(0, 200);
    if (s.referrer.type === 'points') {
      await require('../loyalty/loyaltyService').move(ref.referrerCustomerId, s.referrer.amount, 'referral', { orderId: null, note }, transaction);
    } else {
      await require('../storeCredit/storeCreditService').move(ref.referrerCustomerId, s.referrer.amount, 'referral', { note, currency: workspace.defaultCurrency }, transaction);
    }
    return ref.update({ status: 'rewarded', reward: { ...s.referrer }, rewardedAt: new Date() }, { transaction });
  });
  return null;
}

/** order.cancelled / order.returned before delivery was rewarded: the invite is void. A given reward stays. */
async function onVoided(event, reason) {
  const p = event.payload || {};
  if (!p.orderId) return null;
  await db.CustomerReferral.update({ status: 'void', voidReason: reason }, { where: { orderId: p.orderId, status: 'pending' } });
  return null;
}

// ----------------------------------------------------------------- routes --

const view = (r) => ({
  id: r.id,
  status: r.status,
  voidReason: r.voidReason,
  reward: r.reward,
  rewardedAt: r.rewardedAt,
  createdAt: r.createdAt,
  order: r.order ? { id: r.order.id, orderNumber: r.order.orderNumber, totalAmount: String(r.order.totalAmount), currency: r.order.currency } : null,
  referrer: r.referrer ? { id: r.referrer.id, name: r.referrer.fullName } : undefined,
  friend: r.friend ? { id: r.friend.id, name: r.friend.fullName } : undefined,
});

// Mounted at /api/v1/workspaces/:workspaceId/customer-referrals.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('customer_referrals'));
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
staff.get('/', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), validate({ params: Joi.object(ws) }), asyncHandler(async (req, res) => res.json(settingsOf(await db.Workspace.findByPk(req.tenant.workspaceId, { attributes: ['settings'] })))));
staff.put(
  '/',
  requirePermission(PERMISSIONS.DISCOUNTS_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      enabled: Joi.boolean().required(),
      friend: Joi.object({ percentOff: Joi.number().integer().min(0).max(50).default(0), freeShipping: Joi.boolean().default(false) }).required(),
      referrer: Joi.object({ type: Joi.string().valid('store_credit', 'points').required(), amount: Joi.number().integer().min(1).max(1e9).required() }).required(),
      minOrderAmount: Joi.number().integer().min(1).max(1e12).allow(null).default(null),
      maxRewardsPerReferrer: Joi.number().integer().min(1).max(1000).allow(null).default(null),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (b.enabled && !b.friend.percentOff && !b.friend.freeShipping) throw new ValidationError([{ field: 'friend', message: 'Give the friend a percent off or free shipping' }]);
    const workspace = await db.Workspace.findByPk(req.tenant.workspaceId);
    if (b.enabled && b.referrer.type === 'points' && !require('../loyalty/loyaltyService').settingsOf(workspace).enabled) {
      throw new ValidationError([{ field: 'referrer.type', message: 'Turn on loyalty points first, or reward with store credit' }]);
    }
    await workspace.update({ settings: { ...(workspace.settings || {}), customer_referrals: b } });
    await recordAudit({ workspaceId: workspace.id, actorUserId: req.user.id, action: 'customer_referrals.update', entityType: 'Workspace', entityId: workspace.id, after: b, req });
    res.json(settingsOf(workspace));
  })
);
staff.get(
  '/list',
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW),
  validate({ params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('pending', 'rewarded', 'void'), customerId: Joi.string().uuid(), limit: Joi.number().integer().min(1).max(200).default(50), offset: Joi.number().integer().min(0).default(0) }) }),
  asyncHandler(async (req, res) => {
    const where = { workspaceId: req.tenant.workspaceId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.customerId) where[Op.or] = [{ referrerCustomerId: req.query.customerId }, { friendCustomerId: req.query.customerId }];
    const { rows, count } = await db.CustomerReferral.findAndCountAll({
      where,
      include: [
        { model: db.Customer, as: 'referrer', attributes: ['id', 'fullName'] },
        { model: db.Customer, as: 'friend', attributes: ['id', 'fullName'] },
        { model: db.Order, as: 'order', attributes: ['id', 'orderNumber', 'totalAmount', 'currency'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: req.query.limit,
      offset: req.query.offset,
    });
    // A referrer or friend who comes hidden (orders/orderLock) is listed without a name.
    const orderLock = require('../orders/orderLock');
    const people = rows.flatMap((r) => [r.referrer && r.referrer.id, r.friend && r.friend.id]).filter(Boolean);
    const hidden = await orderLock.lockedCustomerIds(await orderLock.contextFor(req.tenant.workspaceId), req.tenant.workspaceId, people);
    const named = (person) => person && (hidden.has(person.id) ? orderLock.maskFields(person, ['name']) : person);
    res.json({ referrals: rows.map(view).map((r) => ({ ...r, referrer: named(r.referrer), friend: named(r.friend) })), total: count });
  })
);

// Mounted at /api/v1/store/:workspaceId/account/referral — the signed-in shopper's invite.
const account = Router({ mergeParams: true });
account.use(requireStoreFeature('customer_referrals'));
account.get('/', resolvePublicWorkspace, asyncHandler(async (req, res) => {
  const customer = await require('../shopperAccounts/shopperAuth').readToken(req.publicWorkspace.id, req.headers['x-shopper-token']);
  if (!customer) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in again', 401);
  const workspace = await db.Workspace.findByPk(req.publicWorkspace.id, { attributes: ['id', 'settings'] });
  const s = settingsOf(workspace);
  res.set('Cache-Control', 'private, no-store');
  if (!s.enabled) return res.json({ enabled: false });
  const code = await codeFor(workspace.id, customer.id);
  const rows = await db.CustomerReferral.findAll({ where: { referrerCustomerId: customer.id }, order: [['createdAt', 'DESC']], limit: 50 });
  const count = (st) => rows.filter((r) => r.status === st).length;
  return res.json({
    enabled: true,
    code: code.code,
    path: `/?ref=${code.code}`,
    offer: publicOffer(s),
    stats: { pending: count('pending'), rewarded: count('rewarded') },
    // Friends are not named to the referrer.
    referrals: rows.map((r) => ({ id: r.id, status: r.status, reward: r.reward, rewardedAt: r.rewardedAt, createdAt: r.createdAt })),
  });
}));

// Mounted at /api/v1/store/:workspaceId/referrals — the friend's landing banner.
const store = Router({ mergeParams: true });
store.use(requireStoreFeature('customer_referrals'));
store.get('/:code', resolvePublicWorkspace, validate({ params: Joi.object({ workspaceId: Joi.string().required(), code: Joi.string().max(16).required() }) }), asyncHandler(async (req, res) => {
  const workspace = await db.Workspace.findByPk(req.publicWorkspace.id, { attributes: ['id', 'settings'] });
  const s = settingsOf(workspace);
  const row = s.enabled ? await findCode(workspace.id, req.params.code) : null;
  res.json(row ? { valid: true, code: row.code, friend: s.friend } : { valid: false });
}));

module.exports = { staff, account, store, settingsOf, applyAtCheckout, recordOnOrder, onDelivered, onVoided, codeFor };
