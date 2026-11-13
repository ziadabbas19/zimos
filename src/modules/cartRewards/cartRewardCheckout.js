'use strict';

const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const rules = require('./cartRewardRules');

/*
 * Cart rewards on a priced cart — the one place the money is worked out, used
 * by the shipping quote (what the cart drawer, the cart page and the checkout
 * show) and by createOrder (what the order is charged). Nothing the shopper's
 * browser sends is taken as an amount: the lines are priced by the server,
 * the coupon is evaluated by the server and the fees come from the store's
 * shipping settings.
 *
 * The rules (cartRewardRules.js):
 *  - the shopper gets the single best benefit among the highest discount tier
 *    reached, a free-shipping tier reached (worth the delivery fee) and the
 *    code — or, with no code, the store's automatic discount. Best = the most
 *    money saved;
 *  - with allowCouponStacking the reward and the code both apply, the code's
 *    amount taken on the subtotal after the reward's discount;
 *  - thresholds look at the subtotal after product and offer prices, bundles
 *    and combos, before any coupon and shipping.
 */

/**
 * The lines with the reward's discount spread over them in proportion (whole
 * minor units, the remainder on the last line), free gifts left out: what a
 * stacked code is worked out on, and what tax is charged on.
 */
function linesAfterReward(lines, amount) {
  const discount = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!discount) return lines;
  const { allocate } = require('../bundles/bundlePricing');
  const indexes = lines.map((l, i) => i).filter((i) => !lines[i].freeGift && Number(lines[i].lineTotalAmount) > 0);
  const shares = allocate(
    discount,
    indexes.map((i) => Number(lines[i].lineTotalAmount))
  );
  const out = lines.map((line) => ({ ...line }));
  indexes.forEach((i, k) => {
    out[i].lineTotalAmount = Math.max(0, Number(out[i].lineTotalAmount) - shares[k]);
  });
  return out;
}

/**
 * The reward decision for a priced cart.
 *
 *   settings  cartRewardService.activeSettings
 *   lines     the priced lines, after bundles and combos
 *   subtotal  Σ their totals
 *   coupon    null, or { discount, amount }: the code or automatic discount
 *             the cart gets on its own (amount = what it takes off the items)
 *   fees      { full, free }: what the delivery costs without and with free
 *             shipping; null while it is not known (no governorate yet)
 *
 * Returns {
 *   reward          null or { type, value, thresholdAmount, label, amount, freeShipping }
 *   rewardDiscount  what the reward takes off the items (0 for free shipping)
 *   keepCoupon      the code / automatic discount stays on the order
 *   couponAmount    what it takes off the items now (on the reward-reduced
 *                   lines when stacked)
 *   couponValue     all it saves (items, its share of the fee, a free-shipping code's fee)
 *   freeShipping    the reward makes the order ship free
 *   notes           cartRewardRules.NOTES that apply
 *   progress        cartRewardRules.progress for the bar
 * }
 */
async function price(settings, { lines, subtotal, coupon, fees, transaction }) {
  const discountRules = require('../discounts/discountRules');
  const known = fees && fees.full !== null && fees.full !== undefined;
  const fullFee = known ? Math.max(0, Number(fees.full) || 0) : null;
  const freeWorth = known ? Math.max(0, fullFee - Math.max(0, Number(fees.free) || 0)) : null;

  const tier = rules.bestTierReward(settings.tiers, subtotal, freeWorth, settings.currency);
  const couponFreeShipping = Boolean(coupon && coupon.discount && coupon.discount.type === 'free_shipping');
  const couponValue = coupon
    ? Number(coupon.amount || 0) +
      (known ? discountRules.shippingPart(coupon.discount, Number(coupon.amount || 0), fullFee) : 0) +
      (couponFreeShipping ? freeWorth || 0 : 0)
    : 0;
  const choice = rules.chooseBenefit({
    reward: tier.reward,
    coupon: coupon ? { value: couponValue, freeShipping: couponFreeShipping } : null,
    allowCouponStacking: settings.allowCouponStacking,
  });
  const reward = choice.reward;
  const rewardDiscount = reward && !reward.freeShipping ? reward.amount : 0;
  let couponAmount = coupon && choice.keepCoupon ? Number(coupon.amount || 0) : 0;
  // Stacked: the code's amount on the subtotal after the reward's discount.
  if (coupon && choice.keepCoupon && rewardDiscount > 0) {
    const discountService = require('../discounts/discountService');
    couponAmount = Math.min(subtotal - rewardDiscount, await discountService.amountForLines(coupon.discount, linesAfterReward(lines, rewardDiscount), transaction));
  }
  const notes = [...(reward ? tier.notes : []), ...choice.notes];
  return {
    reward,
    rewardDiscount,
    keepCoupon: choice.keepCoupon,
    couponAmount: Math.max(0, couponAmount),
    couponValue,
    freeShipping: Boolean(reward && reward.freeShipping),
    notes,
    progress: rules.progress(settings.tiers, subtotal, settings.currency),
  };
}

/** What the lines are sold below their list (compare-at) price, and what bundles and combos took off them. */
function lineSavings(lines) {
  return lines.reduce((sum, line) => {
    const listed = Number(line.compareAtUnitAmount);
    const unit = Number(line.unitPriceAmount);
    const below = Number.isFinite(listed) && listed > unit ? (listed - unit) * Number(line.quantity) : 0;
    return sum + below + (Math.trunc(Number(line.lineDiscountAmount)) || 0);
  }, 0);
}

/**
 * The quote's `rewards` and what it changes in the quote, or null when cart
 * rewards are not in force (the quote is then exactly as before).
 *
 *   ctx.lines / subtotal   the quote's priced lines
 *   ctx.discountCode       the code typed at checkout, if any (checked like the
 *                          coupon preview: no for-whom rules)
 *   ctx.fees(free)         the delivery as the quote prices it: { amount, shipping }
 *   ctx.feeKnown           the amount does not wait for a governorate
 *   ctx.delivery           { pickup, zoneId }: the checkout's choice
 */
async function forQuote(workspaceId, ctx) {
  const settings = await require('./cartRewardService').activeSettings(workspaceId);
  if (!settings) return null;
  if (ctx.currency && settings.currency && ctx.currency !== settings.currency) return null;

  const couponExtras = require('../discounts/couponExtras');
  const discountService = require('../discounts/discountService');
  const productIds = ctx.lines.filter((l) => !l.freeGift).map((l) => l.productId);
  let coupon = null;
  let refused = null;
  if (ctx.discountCode) {
    try {
      const evaluation = await discountService.evaluate(workspaceId, String(ctx.discountCode).trim().toUpperCase(), {
        subtotal: ctx.subtotal,
        productIds,
        lines: ctx.lines,
        customerId: null,
      });
      coupon = { discount: evaluation.discount, amount: evaluation.amount, code: evaluation.discount.code, automatic: false };
    } catch (err) {
      if (!(err instanceof AppError) || err.statusCode !== 422) throw err;
      refused = err.code;
    }
  } else {
    const automatic = await couponExtras.bestAutomatic(workspaceId, { subtotal: ctx.subtotal, productIds, lines: ctx.lines, customerId: null, funnelId: null, who: null });
    if (automatic) coupon = { discount: automatic.discount, amount: automatic.amount, code: null, automatic: true };
  }

  const delivery = ctx.delivery || {};
  let fees = null;
  let full = null;
  let free = null;
  if (delivery.pickup) {
    fees = { full: 0, free: 0 };
  } else if (ctx.feeKnown) {
    full = await ctx.fees(false);
    free = await ctx.fees(true);
    fees = { full: full.amount, free: free.amount };
    if (delivery.zoneId) {
      const zone = await db.DeliveryZone.findOne({ where: { id: delivery.zoneId, workspaceId, active: true } });
      // A zone's fee replaces the destination price, as createOrder charges it; free shipping makes it 0.
      if (zone) fees = { full: full.destinationIndependent ? full.amount : Number(zone.feeAmount), free: 0 };
    }
  }

  const decision = await price(settings, { lines: ctx.lines, subtotal: ctx.subtotal, coupon, fees });
  const couponPart = coupon && decision.keepCoupon ? decision.couponValue - Number(coupon.amount || 0) + decision.couponAmount : 0;
  const rewardWorth = decision.reward ? decision.reward.amount : 0;
  const compareAtSavings = lineSavings(ctx.lines);
  return {
    decision,
    shippingFree: decision.freeShipping ? free : null,
    // An automatic discount the reward replaced is not given; a stacked one is worked out after the reward.
    automaticDiscount:
      coupon && coupon.automatic
        ? decision.keepCoupon
          ? { amount: decision.couponAmount, type: coupon.discount.type, value: Number(coupon.discount.value) }
          : null
        : undefined,
    rewards: {
      currency: settings.currency,
      allowCouponStacking: settings.allowCouponStacking,
      tiers: decision.progress.tiers,
      next: decision.progress.next,
      applied: decision.reward,
      discountAmount: decision.rewardDiscount,
      coupon: coupon
        ? { code: coupon.code, automatic: coupon.automatic, applied: decision.keepCoupon, amount: decision.keepCoupon ? decision.couponAmount : Number(coupon.amount || 0) }
        : refused
          ? { code: String(ctx.discountCode).trim().toUpperCase(), automatic: false, applied: false, amount: 0, refused }
          : null,
      notes: decision.notes,
      // The fee the delivery would cost without free shipping; null until known.
      shippingFeeAmount: fees ? fees.full : null,
      compareAtSavings,
      savedAmount: compareAtSavings + rewardWorth + Math.max(0, couponPart),
    },
  };
}

module.exports = { price, linesAfterReward, lineSavings, forQuote };
