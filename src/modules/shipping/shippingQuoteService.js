'use strict';

const { add } = require('../../core/utils/money');
const { priceLine } = require('../orders/orderService');
const { calculateShippingAmount } = require('./shippingPricing');

/**
 * The shipping line a checkout would get, for the storefront to show before
 * the order is placed. Lines are priced from server-side data exactly as
 * createOrder prices them (nothing is reserved), and the amount comes from
 * the same calculateShippingAmount — so the quote and the order agree.
 * Discount codes are not applied: the free-shipping threshold, like the
 * order's, looks at the pre-discount subtotal.
 */
async function quote(workspaceId, { country, region, items }) {
  const lines = [];
  for (const item of items) lines.push(await priceLine(workspaceId, item));

  const subtotal = add(...lines.map((l) => l.lineTotalAmount));
  const shipping = await calculateShippingAmount(workspaceId, {
    country,
    region: region || null,
    subtotal,
    totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
    offerShippingOverride: lines.find((l) => l.shippingOverride)?.shippingOverride || null,
    weightLines: lines.map((l) => ({ quantity: l.quantity, units: l.weightUnits })),
  });

  return {
    pricingMode: shipping.pricingMode,
    amount: shipping.amount,
    currency: lines[0].currency,
    subtotal,
    weightGrams: shipping.weightGrams,
    weightEstimated: shipping.weightEstimated,
    tier: shipping.tier,
  };
}

module.exports = { quote };
