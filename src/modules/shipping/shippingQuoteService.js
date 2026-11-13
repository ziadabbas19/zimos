'use strict';

const db = require('../../db/models');
const { add } = require('../../core/utils/money');
const { priceLine } = require('../orders/orderService');
const { calculateShippingAmount } = require('./shippingPricing');
const { DESTINATION_INDEPENDENT, RULES, settingsPriceShipping } = require('./shippingRules');

/**
 * The shipping line a checkout would get, for the storefront to show before
 * the order is placed. Lines are priced from server-side data exactly as
 * createOrder prices them (nothing is reserved), and the amount comes from
 * the same calculateShippingAmount — so the quote and the order agree.
 * Discount codes are not applied: the free-shipping threshold, like the
 * order's, looks at the pre-discount subtotal.
 *
 * On top of the amount:
 *   rule                 which rule priced it (shippingRules.RULES)
 *   baseAmount           the destination's rate before extra fees
 *   extraFeesAmount      Σ the cart's "extra fee" products
 *   governorate          the governorate code a governorate rate matched, else null
 *   freeShipping         { thresholdAmount, remainingAmount, qualified } or null
 *   destinationRequired  the amount depends on the governorate: until one is
 *                        chosen the storefront says so instead of a number
 *   configured           the store prices shipping at all. When false every
 *                        order is charged 0 and the storefront keeps its
 *                        "confirmed on the call" line, as it always has.
 *   lineSavingsAmount    Σ (compare-at − price) × quantity, plus bundle and
 *                        combo savings: the cart sheet's "you saved", every store
 *   rewards              cart rewards (modules/cartRewards), only while they
 *                        are in force for the store and not in a funnel: the
 *                        bar's tiers, the reward these items get against the
 *                        code (`discountCode`) or the automatic discount, and
 *                        what the shopper saves. A free-shipping reward makes
 *                        `amount` and `options` the free ones and clears
 *                        `freeShipping`; an automatic discount the reward
 *                        replaces is left out of `automaticDiscount`. Absent
 *                        otherwise, so the quote is exactly as before.
 *                        `deliveryMethod`, `deliveryZoneId` and
 *                        `shippingOption` (the checkout's choices) price the
 *                        fee free shipping is worth, as the order will.
 */
async function quote(workspaceId, { country, region, items, funnelId = null, discountCode = null, deliveryMethod = null, deliveryZoneId = null, shippingOption = null }) {
  const lines = [];
  // A combo (modules/combos) weighs, ships and costs what its products do, at the combo's price.
  const combos = require('../combos/comboPricing');
  for (const item of await combos.expandItems(workspaceId, items)) {
    const line = await priceLine(workspaceId, item);
    const combo = combos.comboOf(item);
    if (combo) Object.assign(line, { comboKey: combo.key, combo });
    lines.push(line);
  }
  combos.applyComboPricing(lines);
  // The same bundle pricing the order will get, so the quote's subtotal is the real one.
  const bundles = await require('../bundles/bundlePricing').applyBundleTiers(workspaceId, lines);

  const subtotal = add(...lines.map((l) => l.lineTotalAmount));
  const shippingArgs = {
    country,
    region: region || null,
    subtotal,
    totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
    offerShippingOverride: lines.find((l) => l.shippingOverride)?.shippingOverride || null,
    weightLines: lines.map((l) => ({ quantity: l.quantity, units: l.weightUnits })),
    productLines: lines.map((l) => l.shippingRule),
    // A funnel's checkout: its shipping group (funnels/funnelShipping.js).
    funnelId,
  };
  const shipping = await calculateShippingAmount(workspaceId, shippingArgs);
  const shippingOptions = require('./shippingOptions');

  const result = {
    pricingMode: shipping.pricingMode,
    // The choices the shopper has (standard first), with their amounts; [] = none (shippingOptions.js).
    options: await shippingOptions.quoteOptions(workspaceId, shipping),
    amount: Number(shipping.amount),
    currency: lines[0].currency,
    subtotal,
    // What quantity bundles took off (already out of `subtotal`), and which.
    bundleDiscountAmount: bundles.reduce((sum, b) => sum + b.amount, 0),
    bundles,
    // automaticDiscount (what a no-code discount will take off) and
    // minimumOrder (the store's minimum and how far these items are from it).
    // A product- or collection-limited automatic discount counts its covered lines only.
    ...(await require('../discounts/couponExtras').quoteExtras(workspaceId, { subtotal, productIds: lines.map((l) => l.productId), lines })),
    weightGrams: shipping.weightGrams,
    weightEstimated: shipping.weightEstimated,
    tier: shipping.tier,
    rule: shipping.rule,
    baseAmount: Number(shipping.baseAmount),
    extraFeesAmount: shipping.extraFeesAmount,
    governorate: shipping.governorate,
    freeShipping: shipping.freeShipping,
    destinationRequired: !DESTINATION_INDEPENDENT.includes(shipping.rule),
    configured: await pricesShipping(workspaceId, shipping),
    // What these lines sell below their compare-at price, plus what bundles and
    // combos took off them: the cart's "you saved", for every store whether or
    // not it gives rewards (the rewards' `savedAmount` adds the reward and code).
    lineSavingsAmount: require('../cartRewards/cartRewardCheckout').lineSavings(lines),
  };

  // Cart rewards: not in a funnel's checkout, which prices its own way.
  if (!funnelId) {
    // The delivery as the order would be charged for it: the standard price or the chosen option, with or without free shipping.
    const fees = async (free) => {
      const priced = free
        ? await calculateShippingAmount(workspaceId, {
            ...shippingArgs,
            // Free shipping beats an offer's own shipping price, as a free-shipping code does in createOrder.
            offerShippingOverride: null,
            productLines: lines.map((l) => (l.shippingRule ? { ...l.shippingRule, mode: 'free', extraAmount: null } : l.shippingRule)),
          })
        : shipping;
      const option = shippingOption ? (await shippingOptions.quoteOptions(workspaceId, priced)).find((o) => o.key === shippingOption) : null;
      return { shipping: priced, amount: option ? Number(option.amount) : Number(priced.amount), destinationIndependent: DESTINATION_INDEPENDENT.includes(priced.rule) };
    };
    const rewarded = await require('../cartRewards/cartRewardCheckout').forQuote(workspaceId, {
      lines,
      subtotal,
      currency: result.currency,
      discountCode,
      delivery: { pickup: deliveryMethod === 'pickup', zoneId: deliveryZoneId },
      feeKnown: Boolean(region) || DESTINATION_INDEPENDENT.includes(shipping.rule),
      fees,
    });
    if (rewarded) {
      result.rewards = rewarded.rewards;
      if (rewarded.automaticDiscount !== undefined) result.automaticDiscount = rewarded.automaticDiscount;
      if (rewarded.shippingFree) {
        const free = rewarded.shippingFree.shipping;
        Object.assign(result, {
          options: await shippingOptions.quoteOptions(workspaceId, free),
          amount: Number(free.amount),
          rule: free.rule,
          baseAmount: Number(free.baseAmount),
          extraFeesAmount: free.extraFeesAmount,
          // Shipping is already free: the store's own threshold has nothing left to say.
          freeShipping: null,
          destinationRequired: !DESTINATION_INDEPENDENT.includes(free.rule),
        });
      }
    }
  }
  return result;
}

async function pricesShipping(workspaceId, shipping) {
  if (shipping.rule === RULES.OFFER_OVERRIDE || shipping.rule === RULES.ALL_ITEMS_FREE) return true;
  if (shipping.extraFeesAmount > 0) return true;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  if (settingsPriceShipping(workspace && workspace.settings)) return true;
  return (await db.ShippingZone.count({ where: { workspaceId, isActive: true } })) > 0;
}

module.exports = { quote };
