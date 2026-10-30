'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const db = require('../../db/models');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const discountService = require('./discountService');
const rules = require('./discountRules');
const { controls } = require('./discountValidation');

/*
 * What SPEC §10.5–10.6 adds on top of the discounts module:
 *
 *   bulk codes           N random codes sharing one set of rules, for a
 *                        campaign with influencers;
 *   automatic discounts  a discount with no code is applied by itself when
 *                        its conditions hold and the shopper entered no code;
 *   coupon preview       what a code would take off these items, for the
 *                        storefront (a ?coupon= link, the code box);
 *   minimum order        settings.min_order_amount: a storefront order below
 *                        it is refused with a clear message.
 *
 * The amounts are computed by discountService.amountFor, the same function a
 * typed code uses.
 */

const MIN_ORDER_KEY = 'min_order_amount';
const MAX_BULK = 500;
// No 0/O, 1/I/L: a code is read out and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const uuid = Joi.string().uuid();

const schemas = {
  bulk: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      count: Joi.number().integer().min(1).max(MAX_BULK).required(),
      prefix: Joi.string()
        .trim()
        .uppercase()
        .pattern(/^[A-Z0-9]*$/)
        .max(20)
        .allow('')
        .default(''),
      length: Joi.number().integer().min(4).max(12).default(8),
      type: Joi.string().valid('percentage', 'fixed', 'free_shipping').required(),
      value: Joi.number().integer().min(0).optional(),
      minimumSubtotal: Joi.number().integer().min(0).optional(),
      productRestrictions: Joi.array().items(uuid).default([]),
      startsAt: Joi.date().iso().optional(),
      endsAt: Joi.date().iso().optional(),
      // One use per code is what a personal code usually means.
      usageLimit: Joi.number().integer().min(1).default(1),
      perCustomerLimit: Joi.number().integer().min(1).optional(),
      // The same controls as one coupon (discountValidation.controls).
      ...controls(),
    }),
  },
  orderRules: Joi.object({ minOrderAmount: Joi.number().integer().min(0).max(100000000000).allow(null).required() }),
};

function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Creates `count` discounts that differ only in their random code. Returns the codes. */
async function bulkGenerate(workspaceId, data, req) {
  const { count, prefix, length, ...rules } = data;
  if (rules.type !== 'free_shipping' && !rules.value) {
    throw new ValidationError([{ field: 'value', message: 'Enter the discount value' }]);
  }
  if (rules.type === 'percentage' && rules.value > 10000) {
    throw new ValidationError([{ field: 'value', message: 'A percentage cannot be more than 100%' }]);
  }
  const taken = new Set(
    (await db.Discount.findAll({ where: { workspaceId, code: { [db.Sequelize.Op.ne]: null } }, attributes: ['code'], raw: true })).map(
      (row) => row.code
    )
  );
  const codes = [];
  let attempts = 0;
  while (codes.length < count) {
    attempts += 1;
    if (attempts > count * 20) throw new AppError('CODE_SPACE_EXHAUSTED', 'Could not find enough free codes; use longer codes', 409);
    const code = `${prefix ? `${prefix}-` : ''}${randomCode(length)}`;
    if (taken.has(code)) continue;
    taken.add(code);
    codes.push(code);
  }
  await db.sequelize.transaction(async (transaction) => {
    await db.Discount.bulkCreate(
      codes.map((code) => ({ ...rules, code, workspaceId, status: 'active' })),
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'discount.bulk_create',
      entityType: 'Discount',
      after: { count, prefix, rules },
      req,
      transaction,
    });
  });
  return { count: codes.length, codes };
}

/**
 * Whether an automatic discount's own conditions hold for this order. Returns
 * the products it covers (null = the whole order), or false.
 */
async function automaticApplies(discount, { subtotal, productIds, lines = null, customerId, funnelId, who = null }, now, transaction) {
  if (discount.startsAt && discount.startsAt > now) return false;
  if (discount.endsAt && discount.endsAt < now) return false;
  if (!rules.scheduleOpen(discount.schedule, now)) return false;
  if (discount.minimumSubtotal && subtotal < Number(discount.minimumSubtotal)) return false;
  // Limited to some products or collections: one of them must be in the order.
  const eligible = await discountService.eligibleProducts(discount, productIds, transaction);
  if (eligible && eligible.size === 0) return false;
  if (discount.funnelRestrictions.length && (!funnelId || !discount.funnelRestrictions.includes(funnelId))) return false;
  if (discount.customerRestrictions.length && (!customerId || !discount.customerRestrictions.includes(customerId))) return false;
  if (discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) return false;
  // A for-whom rule needs the shopper: an unknown one (the quote) is not given it.
  const forWhom = discount.audience !== 'any' || (discount.customerPhones || []).length > 0 || (discount.vipTierIds || []).length > 0;
  if (forWhom && !customerId && !(who && who.phoneNormalized)) return false;
  try {
    rules.assertLines(discount, eligible, lines);
    await rules.assertCustomer(discount, { customerId, ...(who || {}) }, { transaction });
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 422) return false;
    throw err;
  }
  return eligible;
}

/**
 * The automatic discount (no code) that takes the most off this order, or
 * null. Only percentage and fixed ones lower the subtotal; the others are
 * left to the code path that knows how to apply them. With `context.lines`
 * (the priced lines), a product- or collection-limited one takes its amount
 * off the lines it covers only.
 */
async function bestAutomatic(workspaceId, context, transaction) {
  const candidates = await db.Discount.findAll({
    // A buy-X-get-Y one gives units away (needs `context.lines`); a free-shipping one is left to the store's threshold.
    where: { workspaceId, code: null, status: 'active', type: ['percentage', 'fixed', 'buy_x_get_y'] },
    transaction,
  });
  const now = new Date();
  let best = null;
  for (const discount of candidates) {
    const eligible = await automaticApplies(discount, context, now, transaction);
    if (eligible === false) continue;
    const amount = discountService.amountOn(discount, eligible, context.lines, context.subtotal);
    if (amount > 0 && (!best || amount > best.amount)) best = { discount, amount };
  }
  return best;
}

function minOrderAmount(settings) {
  const value = Number(settings && settings[MIN_ORDER_KEY]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function workspaceSettings(workspaceId, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'], transaction });
  return (workspace && workspace.settings) || {};
}

/** Refuses a storefront order below the store's minimum (422 MIN_ORDER_NOT_MET). */
async function assertMinimumOrder(workspaceId, subtotal, transaction) {
  const minimum = minOrderAmount(await workspaceSettings(workspaceId, transaction));
  if (minimum !== null && subtotal < minimum) {
    throw new AppError('MIN_ORDER_NOT_MET', 'The order is below the minimum order amount for this store', 422, [
      { field: 'items', message: 'Below the minimum order amount', minimumAmount: minimum, subtotal, remainingAmount: minimum - subtotal },
    ]);
  }
}

/** For the shipping quote: the automatic discount these items would get and where they stand against the minimum. */
async function quoteExtras(workspaceId, { subtotal, productIds, lines = null }) {
  const auto = await bestAutomatic(workspaceId, { subtotal, productIds, lines, customerId: null, funnelId: null, who: null });
  const minimum = minOrderAmount(await workspaceSettings(workspaceId));
  return {
    automaticDiscount: auto ? { amount: auto.amount, type: auto.discount.type, value: Number(auto.discount.value) } : null,
    minimumOrder: minimum === null ? null : { amount: minimum, remainingAmount: Math.max(0, minimum - subtotal), met: subtotal >= minimum },
  };
}

async function getOrderRules(workspaceId) {
  return { minOrderAmount: minOrderAmount(await workspaceSettings(workspaceId)) };
}

async function saveOrderRules(workspaceId, data, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    const before = { minOrderAmount: minOrderAmount(workspace.settings) };
    workspace.settings = { ...(workspace.settings || {}), [MIN_ORDER_KEY]: data.minOrderAmount || null };
    workspace.changed('settings', true);
    await workspace.save({ transaction });
    const after = { minOrderAmount: minOrderAmount(workspace.settings) };
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order_rules.update',
      entityType: 'Workspace',
      entityId: workspaceId,
      before,
      after,
      req,
      transaction,
    });
    return after;
  });
}

/**
 * What `code` would take off these items — the storefront's preview. Never
 * throws for a bad code: `valid: false` with the reason's code, so the page
 * can say why in the shopper's language. The for-whom rules (first order,
 * returning customers, the phone list, the per-customer limit) are not
 * previewed: they would tell anyone whether a phone ever ordered from the
 * store. The checkout, behind its bot guard, checks them and says why.
 */
async function previewCode(workspaceId, code, items, visitorId = null, funnelId = null) {
  const { priceLine } = require('../orders/orderService');
  const { applyBundleTiers } = require('../bundles/bundlePricing');
  const lines = [];
  // A product A/B test's price for this visitor (catalog/productTests.js).
  for (const item of await require('../catalog/productTests').pinPrices(workspaceId, items, visitorId)) lines.push(await priceLine(workspaceId, item));
  await applyBundleTiers(workspaceId, lines);
  const subtotal = lines.reduce((sum, line) => sum + Number(line.lineTotalAmount), 0);
  try {
    const { discount, amount } = await discountService.evaluate(workspaceId, String(code).trim().toUpperCase(), {
      subtotal,
      productIds: lines.filter((line) => !line.freeGift).map((line) => line.productId),
      lines,
      customerId: null,
      // A code limited to some funnels applies in those funnels' checkouts only.
      funnelId,
    });
    // A free-shipping code takes nothing off the items: the order ships free.
    return {
      valid: true,
      code: discount.code,
      type: discount.type,
      amount,
      freeShipping: discount.type === 'free_shipping',
      // It comes off the delivery fee too (the checkout knows the fee, the preview does not).
      appliesToShipping: Boolean(discount.appliesToShipping),
      subtotal,
      reason: null,
    };
  } catch (err) {
    // DISCOUNT_QUANTITY_NOT_MET / _MIN_QUANTITY_NOT_MET / _MINIMUM_NOT_MET say how much more is needed.
    if (err instanceof AppError && err.statusCode === 422) {
      const withDetails = ['DISCOUNT_QUANTITY_NOT_MET', 'DISCOUNT_MIN_QUANTITY_NOT_MET', 'DISCOUNT_MINIMUM_NOT_MET', 'DISCOUNT_NOT_ACTIVE_NOW'];
      return { valid: false, code, type: null, amount: 0, freeShipping: false, subtotal, reason: err.code, ...(withDetails.includes(err.code) ? { details: err.details } : {}) };
    }
    throw err;
  }
}

module.exports = {
  MIN_ORDER_KEY,
  MAX_BULK,
  schemas,
  bulkGenerate,
  bestAutomatic,
  assertMinimumOrder,
  quoteExtras,
  getOrderRules,
  saveOrderRules,
  previewCode,
};
