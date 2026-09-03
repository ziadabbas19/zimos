'use strict';

const db = require('../../db/models');

/**
 * Selects the cheapest applicable shipping rate for a destination + order
 * shape. Real carrier integration (waybill creation, tracking) lives in
 * modules/shipping/carriers/*; this function only prices the shipping line
 * shown at checkout.
 */
async function calculateShippingAmount(workspaceId, { country, region, subtotal, totalWeightGrams, totalQuantity, offerShippingOverride }) {
  if (offerShippingOverride && offerShippingOverride.amount !== undefined) {
    return offerShippingOverride.amount;
  }

  const zones = await db.ShippingZone.findAll({
    where: { workspaceId, countries: { [db.Sequelize.Op.contains]: [country] } },
    include: [{ model: db.ShippingRate, as: 'rates' }],
  });

  const applicableZone = zones.find((z) => !region || !z.excludedRegions.includes(region));
  if (!applicableZone || applicableZone.rates.length === 0) {
    return 0; // No shipping configured for this destination — treated as free rather than blocking checkout.
  }

  const candidates = applicableZone.rates.map((rate) => computeRateAmount(rate, { subtotal, totalWeightGrams, totalQuantity }));
  return Math.min(...candidates);
}

function computeRateAmount(rate, { subtotal, totalWeightGrams, totalQuantity }) {
  switch (rate.rateType) {
    case 'free':
      return 0;
    case 'flat':
      return rate.config.amount || 0;
    case 'weight_based': {
      const tier = (rate.config.tiers || []).find((t) => totalWeightGrams <= t.upToGrams);
      return tier ? tier.amount : rate.config.overflowAmount || 0;
    }
    case 'quantity_based': {
      const tier = (rate.config.tiers || []).find((t) => totalQuantity <= t.upToQuantity);
      return tier ? tier.amount : rate.config.overflowAmount || 0;
    }
    case 'order_value_based': {
      const sorted = [...(rate.config.tiers || [])].sort((a, b) => b.minSubtotal - a.minSubtotal);
      const tier = sorted.find((t) => subtotal >= t.minSubtotal);
      return tier ? tier.amount : 0;
    }
    default:
      return 0;
  }
}

module.exports = { calculateShippingAmount };
