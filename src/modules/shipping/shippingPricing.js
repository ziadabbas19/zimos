'use strict';

const db = require('../../db/models');
const { summarizeWeight, describeTiers, resolveTier } = require('./shippingWeight');

/**
 * Prices the shipping line shown at checkout and works out the order's
 * weight and weight tier. Real carrier integration (waybill creation,
 * tracking) lives in modules/shipping/carriers/*.
 *
 * Weight: `weightLines` (see shippingWeight.summarizeWeight) are weighed with
 * the store's default_item_weight_grams standing in for a missing variant
 * weight. Callers that only have a number may pass `totalWeightGrams`
 * instead. The tier is resolved whenever the store has tiers, in either
 * pricing mode, because courier bookings use it too.
 *
 * Amount precedence, highest first, in both modes:
 *   1. No destination country → 0 (nothing to price against).
 *   2. An offer-level shipping override always wins.
 *   3. A configured free-shipping threshold the subtotal reaches → 0.
 *   4. The matching active zone — one lookup (findApplicableZone) shared by
 *      both modes, so a destination always lands in the same zone — priced
 *      by settings.shipping_pricing_mode:
 *        'rates' (default)  the cheapest active rate in that zone, exactly as
 *                           before tiers existed. Weight-based rates see
 *                           known weights only (a missing weight counts as
 *                           0), never the default weight.
 *        'weight_tiers'     that zone's price for the order's tier. Other
 *                           matching zones are not consulted.
 *   5. The workspace's default shipping rate, or 0 when none is set (free
 *      rather than blocking checkout) — when no zone matches, or the zone has
 *      no active rate / no price for the tier.
 *
 * @returns {Promise<{ amount: number, weightGrams: number|null, tier: object|null,
 *   weightEstimated: boolean, pricingMode: string, lineWeights: Array<number|null> }>}
 */
async function calculateShippingAmount(
  workspaceId,
  { country, region, subtotal, totalWeightGrams, totalQuantity, offerShippingOverride, weightLines, transaction }
) {
  const workspace = await db.Workspace.findByPk(workspaceId, { transaction });
  const settings = (workspace && workspace.settings) || {};
  const pricingMode = settings.shipping_pricing_mode === 'weight_tiers' ? 'weight_tiers' : 'rates';

  const weight = weightLines
    ? summarizeWeight(weightLines, settings.default_item_weight_grams ?? null)
    : {
        grams: totalWeightGrams ?? null,
        knownGrams: Number(totalWeightGrams) || 0,
        estimated: false,
        perLine: [],
      };
  const tiers = await loadTiers(workspaceId, transaction);
  const tier = resolveTier(tiers, weight.grams);

  const result = (amount) => ({
    amount,
    weightGrams: weight.grams,
    tier,
    weightEstimated: weight.estimated,
    pricingMode,
    lineWeights: weight.perLine,
  });

  if (!country) return result(0);

  if (offerShippingOverride && offerShippingOverride.amount !== undefined) {
    return result(offerShippingOverride.amount);
  }

  // Free-shipping threshold: an integer minor-unit subtotal at/above which
  // shipping is free, bypassing rate calculation. Only honoured when set.
  const threshold = settings.free_shipping_threshold_amount;
  if (threshold !== undefined && threshold !== null && Number(subtotal) >= Number(threshold)) {
    return result(0);
  }

  // Fallback used whenever no active zone/rate matches the destination.
  const defaultRate = settings.default_shipping_rate_amount;
  const fallbackAmount = defaultRate !== undefined && defaultRate !== null ? Number(defaultRate) : 0;

  const applicableZone = await findApplicableZone(workspaceId, country, region, transaction);
  if (!applicableZone) return result(fallbackAmount);

  if (pricingMode === 'weight_tiers') {
    if (!tier) return result(fallbackAmount);
    const price = await db.ShippingZoneTierPrice.findOne({
      where: { zoneId: applicableZone.id, tierId: tier.id },
      transaction,
    });
    return result(price ? Number(price.amount) : fallbackAmount);
  }

  if (applicableZone.rates.length === 0) return result(fallbackAmount);
  const candidates = applicableZone.rates.map((rate) =>
    computeRateAmount(rate, { subtotal, totalWeightGrams: weight.knownGrams, totalQuantity })
  );
  return result(Math.min(...candidates));
}

/**
 * The zone a destination is priced in: the first active zone for the
 * country that matchesZone accepts, carrying its active rates. This is the
 * lookup rate pricing has always done, kept as one query so tier pricing
 * picks exactly the zone rate pricing would.
 */
async function findApplicableZone(workspaceId, country, region, transaction) {
  const zones = await db.ShippingZone.findAll({
    where: {
      workspaceId,
      isActive: true,
      countries: { [db.Sequelize.Op.contains]: [country] },
    },
    // LEFT JOIN filtered to active rates — a zone with no active rate still
    // comes back (with rates: []) and prices at the fallback.
    include: [{ model: db.ShippingRate, as: 'rates', where: { isActive: true }, required: false }],
    transaction,
  });
  return zones.find((z) => matchesZone(z, region)) || null;
}

/** The workspace's tiers, described and sorted (see shippingWeight). */
async function loadTiers(workspaceId, transaction) {
  const rows = await db.ShippingWeightTier.findAll({ where: { workspaceId }, transaction });
  return describeTiers(rows);
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

module.exports = { calculateShippingAmount, loadTiers, matchesZone, computeRateAmount };
