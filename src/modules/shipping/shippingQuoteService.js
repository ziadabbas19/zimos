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
 */
async function quote(workspaceId, { country, region, items, funnelId = null }) {
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
  const shipping = await calculateShippingAmount(workspaceId, {
    country,
    region: region || null,
    subtotal,
    totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
    offerShippingOverride: lines.find((l) => l.shippingOverride)?.shippingOverride || null,
    weightLines: lines.map((l) => ({ quantity: l.quantity, units: l.weightUnits })),
    productLines: lines.map((l) => l.shippingRule),
    // A funnel's checkout: its shipping group (funnels/funnelShipping.js).
    funnelId,
  });

  return {
    pricingMode: shipping.pricingMode,
    // The choices the shopper has (standard first), with their amounts; [] = none (shippingOptions.js).
    options: await require('./shippingOptions').quoteOptions(workspaceId, shipping),
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
  };
}

async function pricesShipping(workspaceId, shipping) {
  if (shipping.rule === RULES.OFFER_OVERRIDE || shipping.rule === RULES.ALL_ITEMS_FREE) return true;
  if (shipping.extraFeesAmount > 0) return true;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  if (settingsPriceShipping(workspace && workspace.settings)) return true;
  return (await db.ShippingZone.count({ where: { workspaceId, isActive: true } })) > 0;
}

module.exports = { quote };
