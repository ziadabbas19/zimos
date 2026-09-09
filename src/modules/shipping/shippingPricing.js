'use strict';

const db = require('../../db/models');

/**
 * Selects the cheapest applicable shipping rate for a destination + order
 * shape. Real carrier integration (waybill creation, tracking) lives in
 * modules/shipping/carriers/*; this function only prices the shipping line
 * shown at checkout.
 *
 * Precedence, highest first:
 *   1. An offer-level shipping override (a funnel offer that dictates its own
 *      shipping price) always wins.
 *   2. A configured free-shipping threshold the order subtotal reaches → 0.
 *   3. The cheapest active rate in the matching active zone.
 *   4. The workspace's configured default shipping rate, or 0 when none is
 *      set (free rather than blocking checkout).
 */
async function calculateShippingAmount(
  workspaceId,
  { country, region, subtotal, totalWeightGrams, totalQuantity, offerShippingOverride }
) {
  if (offerShippingOverride && offerShippingOverride.amount !== undefined) {
    return offerShippingOverride.amount;
  }

  const workspace = await db.Workspace.findByPk(workspaceId);
  const settings = (workspace && workspace.settings) || {};

  // Free-shipping threshold: an integer minor-unit subtotal at/above which
  // shipping is free, bypassing rate calculation. Only honoured when set.
  const threshold = settings.free_shipping_threshold_amount;
  if (threshold !== undefined && threshold !== null && Number(subtotal) >= Number(threshold)) {
    return 0;
  }

  // Fallback used whenever no active zone/rate matches the destination.
  const defaultRate = settings.default_shipping_rate_amount;
  const fallbackAmount = defaultRate !== undefined && defaultRate !== null ? Number(defaultRate) : 0;

  const zones = await db.ShippingZone.findAll({
    where: {
      workspaceId,
      isActive: true,
      countries: { [db.Sequelize.Op.contains]: [country] },
    },
    // LEFT JOIN filtered to active rates — a zone with no active rate still
    // comes back (with rates: []) and falls through to the fallback below.
    include: [{ model: db.ShippingRate, as: 'rates', where: { isActive: true }, required: false }],
  });

  const applicableZone = zones.find((z) => matchesZone(z, region));
  if (!applicableZone || applicableZone.rates.length === 0) {
    return fallbackAmount;
  }

  const candidates = applicableZone.rates.map((rate) =>
    computeRateAmount(rate, { subtotal, totalWeightGrams, totalQuantity })
  );
  return Math.min(...candidates);
}

/**
 * The destination country is already guaranteed to be in `countries` by the
 * query. On top of that a zone matches when:
 *   - the destination region is not in `excludedRegions`, AND
 *   - if the zone lists positive `regions`, the destination region is one of
 *     them. An empty `regions` list keeps the zone country-only (plus the
 *     exclusion list) — the original behaviour, so zones that only use
 *     `excludedRegions` are unaffected.
 */
function matchesZone(zone, region) {
  if (region && zone.excludedRegions.includes(region)) return false;
  const positiveRegions = Array.isArray(zone.regions) ? zone.regions : [];
  if (positiveRegions.length > 0) {
    return Boolean(region) && positiveRegions.includes(region);
  }
  return true;
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
