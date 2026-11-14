'use strict';

const { applyBasisPoints } = require('../../core/utils/money');

/*
 * Cart rewards, the pure part: which tiers a subtotal reaches, what each one
 * is worth, and which single benefit the shopper gets. No database here; the
 * shipping quote and createOrder both come through cartRewardCheckout.js,
 * which feeds these the priced cart.
 *
 * A tier: { thresholdAmount, type, value, label }
 *   thresholdAmount  minor units, on the subtotal after product and offer
 *                    prices, bundles and combos, before any coupon and shipping
 *   type             percent (value 1–100) | fixed (value in minor units) |
 *                    free_shipping (no value)
 *   label            { ar, en } the merchant wrote, or null for the automatic one
 *
 * Amounts are integer minor units, so rounding to the store's currency is
 * rounding to a whole minor unit (half up, like a percentage coupon).
 */

const TYPES = Object.freeze(['percent', 'fixed', 'free_shipping']);
const MAX_TIERS = 6;
const MAX_TRUST_ITEMS = 4;
const LABEL_MAX = 60;
const TRUST_TEXT_MAX = 80;

/** Why the shopper got what they got, for the cart to say. */
const NOTES = Object.freeze({
  // A discount tier and a free-shipping tier were both reached; the discount saves more.
  DISCOUNT_OVER_FREE_SHIPPING: 'discount_over_free_shipping',
  // The reward saves more than the code (or automatic discount), which is left out.
  REWARD_OVER_COUPON: 'reward_over_coupon',
  // The code (or automatic discount) saves at least as much as the reward, which is left out.
  COUPON_OVER_REWARD: 'coupon_over_reward',
});

const isDiscount = (tier) => tier.type === 'percent' || tier.type === 'fixed';

/** Lowest threshold first; tiers on the same threshold keep the merchant's order. */
function sortTiers(tiers) {
  return (Array.isArray(tiers) ? tiers : [])
    .map((tier, index) => ({ tier, index }))
    .sort((a, b) => Number(a.tier.thresholdAmount) - Number(b.tier.thresholdAmount) || a.index - b.index)
    .map(({ tier }) => tier);
}

/**
 * The checks Joi cannot make on one tier alone: thresholds strictly increasing
 * within each kind of reward (the discounts — percent and fixed — and free
 * shipping), in the order the merchant listed them. [{ field, message }].
 */
function tierErrors(tiers) {
  const errors = [];
  const last = { discount: null, free_shipping: null };
  (tiers || []).forEach((tier, index) => {
    const kind = isDiscount(tier) ? 'discount' : 'free_shipping';
    const threshold = Number(tier.thresholdAmount);
    if (last[kind] !== null && threshold <= last[kind]) {
      errors.push({ field: `tiers.${index}.thresholdAmount`, message: 'Each threshold must be higher than the one before it for the same kind of reward' });
    }
    last[kind] = last[kind] === null ? threshold : Math.max(last[kind], threshold);
  });
  return errors;
}

function majorUnits(amount, currency) {
  const digits = (() => {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    } catch {
      return 2;
    }
  })();
  return { value: Number(amount) / 10 ** digits, digits };
}

/** "EGP 50" / "50 ج.م" — whole amounts without decimals. */
function formatAmount(amount, currency, locale) {
  const { value, digits } = majorUnits(amount, currency);
  const whole = Number.isInteger(value);
  try {
    return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${currency} ${value}`;
  }
}

/** The automatic name of a tier's reward, in both languages. */
function autoLabel(tier, currency = 'EGP') {
  if (tier.type === 'free_shipping') return { en: 'Free shipping', ar: 'شحن مجاني' };
  if (tier.type === 'percent') return { en: `${tier.value}% off`, ar: `خصم ${tier.value}%` };
  return { en: `${formatAmount(tier.value, currency, 'en')} off`, ar: `خصم ${formatAmount(tier.value, currency, 'ar')}` };
}

/** The merchant's own name for the reward where they wrote one, the automatic one otherwise (per language). */
function labelOf(tier, currency = 'EGP') {
  const auto = autoLabel(tier, currency);
  const own = tier.label || {};
  const pick = (lang) => (typeof own[lang] === 'string' && own[lang].trim() ? own[lang].trim() : auto[lang]);
  return { ar: pick('ar'), en: pick('en') };
}

/**
 * What a discount tier takes off `subtotal`: a percentage rounded half up to
 * the minor unit, or the fixed amount, never more than the subtotal. A
 * free-shipping tier takes nothing off the items (its worth is the fee).
 */
function discountOf(tier, subtotal) {
  const base = Math.max(0, Math.trunc(Number(subtotal) || 0));
  if (tier.type === 'percent') return Math.min(base, applyBasisPoints(base, Math.round(Number(tier.value) * 100)));
  if (tier.type === 'fixed') return Math.min(base, Math.max(0, Math.trunc(Number(tier.value) || 0)));
  return 0;
}

const reached = (tier, subtotal) => Number(subtotal) >= Number(tier.thresholdAmount);

/**
 * Where the subtotal stands on the bar: every tier (lowest first) with
 * `reached`, and the next one to reach with how much more it needs.
 */
function progress(tiers, subtotal, currency = 'EGP') {
  const sorted = sortTiers(tiers);
  const list = sorted.map((tier) => ({
    thresholdAmount: Number(tier.thresholdAmount),
    type: tier.type,
    value: tier.type === 'free_shipping' ? null : Number(tier.value),
    label: labelOf(tier, currency),
    // Shown on the bar's marker (barAppearance.js): the merchant's pick, else by kind.
    icon: require('./barAppearance').iconOf(tier),
    reached: reached(tier, subtotal),
  }));
  const nextIndex = list.findIndex((tier) => !tier.reached);
  const next =
    nextIndex === -1
      ? null
      : { index: nextIndex, ...list[nextIndex], remainingAmount: Math.max(0, list[nextIndex].thresholdAmount - Math.max(0, Number(subtotal) || 0)) };
  return { tiers: list, next };
}

/**
 * The best reward the reached tiers give: the discount tier that takes the
 * most off, or a free-shipping tier worth `shippingFee` — whichever saves more
 * money (free shipping on a tie). `shippingFee` null = not known yet (no
 * governorate): a free-shipping tier is then worth 0 and no note is made, so a
 * reached discount shows until the fee is known.
 *
 * Returns { reward, notes } where reward is null or
 *   { type, value, thresholdAmount, label, amount, freeShipping }
 * and `amount` is the money saved (the fee, for free shipping).
 */
function bestTierReward(tiers, subtotal, shippingFee, currency = 'EGP') {
  const hit = sortTiers(tiers).filter((tier) => reached(tier, subtotal));
  let discount = null;
  for (const tier of hit.filter(isDiscount)) {
    const amount = discountOf(tier, subtotal);
    // The higher threshold wins a tie: the later tier is the one the shopper worked towards.
    if (!discount || amount >= discount.amount) discount = { tier, amount };
  }
  const freeTier = hit.filter((tier) => tier.type === 'free_shipping').pop() || null;
  const feeKnown = shippingFee !== null && shippingFee !== undefined;
  const fee = feeKnown ? Math.max(0, Math.trunc(Number(shippingFee) || 0)) : 0;
  const shape = (tier, amount) => ({
    type: tier.type,
    value: tier.type === 'free_shipping' ? null : Number(tier.value),
    thresholdAmount: Number(tier.thresholdAmount),
    label: labelOf(tier, currency),
    amount,
    freeShipping: tier.type === 'free_shipping',
  });

  if (discount && discount.amount > 0 && (!freeTier || discount.amount > fee)) {
    const notes = freeTier && feeKnown && fee > 0 ? [NOTES.DISCOUNT_OVER_FREE_SHIPPING] : [];
    return { reward: shape(discount.tier, discount.amount), notes };
  }
  if (freeTier) return { reward: shape(freeTier, fee), notes: [] };
  return { reward: null, notes: [] };
}

/**
 * The reward against the store's code or automatic discount.
 *
 *   coupon  null, or { value, freeShipping } — `value` is all it saves (items,
 *           its share of the fee, or the whole fee for a free-shipping code)
 *   allowCouponStacking  both apply; a free-shipping reward next to a
 *           free-shipping code adds nothing, so the code alone is kept then
 *
 * Off (the default) the bigger one wins and the other is left out; on a tie
 * the code stays, as it always has.
 *
 * Returns { reward, keepCoupon, notes }.
 */
function chooseBenefit({ reward, coupon, allowCouponStacking }) {
  if (!reward) return { reward: null, keepCoupon: Boolean(coupon), notes: [] };
  if (!coupon) return { reward, keepCoupon: false, notes: [] };
  if (allowCouponStacking) {
    if (reward.freeShipping && coupon.freeShipping) return { reward: null, keepCoupon: true, notes: [] };
    return { reward, keepCoupon: true, notes: [] };
  }
  if (reward.amount > Number(coupon.value || 0)) return { reward, keepCoupon: false, notes: [NOTES.REWARD_OVER_COUPON] };
  return { reward: null, keepCoupon: true, notes: [NOTES.COUPON_OVER_REWARD] };
}

/** The order's discounts_snapshot entry for the reward it was given. */
function snapshotEntry(reward) {
  return {
    kind: 'cart_reward',
    rewardType: reward.type,
    value: reward.value,
    thresholdAmount: reward.thresholdAmount,
    label: reward.label,
    amount: reward.amount,
    freeShipping: reward.freeShipping,
  };
}

/** What an order's reward took off its items, as placed (a free-shipping reward takes nothing off them). */
function placedRewardDiscount(discountsSnapshot) {
  return (discountsSnapshot || [])
    .filter((d) => d && d.kind === 'cart_reward' && d.freeShipping !== true)
    .reduce((sum, d) => sum + (Math.trunc(Number(d.amount)) || 0), 0);
}

/** Whether the order was given free shipping by its reward. */
function placedRewardShipsFree(discountsSnapshot) {
  return (discountsSnapshot || []).some((d) => d && d.kind === 'cart_reward' && d.freeShipping === true);
}

module.exports = {
  TYPES,
  MAX_TIERS,
  MAX_TRUST_ITEMS,
  LABEL_MAX,
  TRUST_TEXT_MAX,
  NOTES,
  sortTiers,
  tierErrors,
  autoLabel,
  labelOf,
  discountOf,
  progress,
  bestTierReward,
  chooseBenefit,
  snapshotEntry,
  placedRewardDiscount,
  placedRewardShipsFree,
  // Shared with the campaign emails' product prices (emailCampaigns/campaignContent.js).
  formatAmount,
};
