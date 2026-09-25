'use strict';

/**
 * Order weight and weight tiers — pure functions, no database.
 *
 * Weights are integer grams. A variant with weightGrams NULL has no weight
 * set; 0 is a real weight. Items of a non-physical product (digital, service)
 * weigh nothing whatever their variant says.
 */

const MAX_WEIGHT_GRAMS = 1000000;
const MAX_TIERS = 20;
const OVER_LAST_TIER = 'weight_over_last_tier';

/**
 * One order line's weight.
 *
 * @param {object} line
 * @param {number} line.quantity  units of the line (bundles, for an offer)
 * @param {Array<{weightGrams: number|null, quantity: number, weightless?: boolean}>} line.units
 *        what ONE unit of the line is made of: a plain variant line is one
 *        entry of quantity 1; an offer is one entry per offer line.
 * @param {number|null} defaultItemWeightGrams  stands in for a missing weight
 * @returns {{ unitGrams: number|null, knownUnitGrams: number, estimated: boolean }}
 *   unitGrams is null when a weight is missing and there is no default.
 *   knownUnitGrams counts missing weights as 0 — what rate-based pricing has
 *   always used.
 */
function lineWeight(line, defaultItemWeightGrams) {
  let unitGrams = 0;
  let knownUnitGrams = 0;
  let estimated = false;
  let unknown = false;
  for (const unit of line.units) {
    if (unit.weightless) continue;
    if (unit.weightGrams === null || unit.weightGrams === undefined) {
      if (defaultItemWeightGrams === null || defaultItemWeightGrams === undefined) unknown = true;
      else {
        estimated = true;
        unitGrams += defaultItemWeightGrams * unit.quantity;
      }
    } else {
      unitGrams += unit.weightGrams * unit.quantity;
      knownUnitGrams += unit.weightGrams * unit.quantity;
    }
  }
  return { unitGrams: unknown ? null : unitGrams, knownUnitGrams, estimated };
}

/**
 * The whole order: `grams` is null when any line's weight is unknown.
 * `perLine` is each line's unit weight, in input order.
 */
function summarizeWeight(lines, defaultItemWeightGrams) {
  let grams = 0;
  let knownGrams = 0;
  let estimated = false;
  let unknown = false;
  const perLine = [];
  for (const line of lines) {
    const w = lineWeight(line, defaultItemWeightGrams);
    perLine.push(w.unitGrams);
    knownGrams += w.knownUnitGrams * line.quantity;
    if (w.estimated) estimated = true;
    if (w.unitGrams === null) unknown = true;
    else grams += w.unitGrams * line.quantity;
  }
  return { grams: unknown ? null : grams, knownGrams, estimated, perLine };
}

/** Tier rows (any order) -> [{ id, position, fromGrams, upToGrams }], sorted. */
function describeTiers(rows) {
  const sorted = [...rows].sort((a, b) => a.position - b.position);
  let from = 0;
  return sorted.map((row) => {
    const tier = { id: row.id, position: row.position, fromGrams: from, upToGrams: row.upToGrams };
    if (row.upToGrams !== null) from = row.upToGrams;
    return tier;
  });
}

/**
 * The tier a weight falls into. Upper bounds are inclusive; the first tier
 * starts at 0. Above a closed last tier the weight is charged as the last
 * tier and flagged — the order is never refused for its weight.
 *
 * @returns {object|null} { id, position, fromGrams, upToGrams, flags } or
 *   null when there are no tiers or the weight is unknown.
 */
function resolveTier(tiers, grams) {
  if (!tiers.length || grams === null || grams === undefined) return null;
  const snapshot = (tier, flags = []) => ({
    id: tier.id,
    position: tier.position,
    fromGrams: tier.fromGrams,
    upToGrams: tier.upToGrams,
    flags,
  });
  for (const tier of tiers) {
    if (tier.upToGrams === null || grams <= tier.upToGrams) return snapshot(tier);
  }
  return snapshot(tiers[tiers.length - 1], [OVER_LAST_TIER]);
}

/**
 * Checks a tier set as the merchant submitted it (upper bounds in order).
 * @returns {Array<{field, message}>} empty when valid
 */
function tierSetErrors(tiers) {
  const errors = [];
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > MAX_TIERS) {
    return [{ field: 'tiers', message: `Between 1 and ${MAX_TIERS} tiers are required` }];
  }
  let previous = 0;
  tiers.forEach((tier, i) => {
    const bound = tier.upToGrams;
    if (bound === null) {
      if (i !== tiers.length - 1) {
        errors.push({ field: `tiers.${i}.upToGrams`, message: 'Only the last tier may be open-ended' });
      }
      return;
    }
    if (bound <= previous) {
      errors.push({ field: `tiers.${i}.upToGrams`, message: 'Each tier must end above the previous one' });
    }
    previous = Math.max(previous, bound);
  });
  const ids = tiers.map((t) => t.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) errors.push({ field: 'tiers', message: 'A tier id appears more than once' });
  return errors;
}

module.exports = {
  MAX_WEIGHT_GRAMS,
  MAX_TIERS,
  OVER_LAST_TIER,
  lineWeight,
  summarizeWeight,
  describeTiers,
  resolveTier,
  tierSetErrors,
};
