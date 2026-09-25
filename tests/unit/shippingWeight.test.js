'use strict';

const {
  lineWeight,
  summarizeWeight,
  describeTiers,
  resolveTier,
  tierSetErrors,
  OVER_LAST_TIER,
} = require('../../src/modules/shipping/shippingWeight');

const tiersOf = (...bounds) => describeTiers(bounds.map((upToGrams, position) => ({ id: `t${position}`, position, upToGrams })));

describe('shippingWeight.lineWeight', () => {
  it('sums every unit of the line; a missing weight takes the default and marks it estimated', () => {
    const line = { quantity: 1, units: [{ weightGrams: 300, quantity: 2 }, { weightGrams: null, quantity: 1 }] };
    expect(lineWeight(line, 500)).toEqual({ unitGrams: 1100, knownUnitGrams: 600, estimated: true });
  });

  it('is unknown (null) when a weight is missing and there is no default', () => {
    const line = { quantity: 1, units: [{ weightGrams: null, quantity: 1 }] };
    expect(lineWeight(line, null)).toEqual({ unitGrams: null, knownUnitGrams: 0, estimated: false });
  });

  it('treats 0 as a real weight and skips weightless (non-physical) items', () => {
    const line = { quantity: 1, units: [{ weightGrams: 0, quantity: 3 }, { weightGrams: null, quantity: 1, weightless: true }] };
    expect(lineWeight(line, 500)).toEqual({ unitGrams: 0, knownUnitGrams: 0, estimated: false });
  });
});

describe('shippingWeight.summarizeWeight', () => {
  it('multiplies each line by its quantity and reports per-line unit weights', () => {
    const lines = [
      { quantity: 2, units: [{ weightGrams: 250, quantity: 1 }] },
      // an offer bundle: 2 × 100 g + 1 × missing (default 400)
      { quantity: 3, units: [{ weightGrams: 100, quantity: 2 }, { weightGrams: null, quantity: 1 }] },
    ];
    expect(summarizeWeight(lines, 400)).toEqual({
      grams: 2 * 250 + 3 * 600,
      knownGrams: 2 * 250 + 3 * 200,
      estimated: true,
      perLine: [250, 600],
    });
  });

  it('is null overall when any line is unknown, but keeps the known weight', () => {
    const lines = [
      { quantity: 1, units: [{ weightGrams: 250, quantity: 1 }] },
      { quantity: 1, units: [{ weightGrams: null, quantity: 1 }] },
    ];
    const result = summarizeWeight(lines, null);
    expect(result.grams).toBeNull();
    expect(result.knownGrams).toBe(250);
    expect(result.perLine).toEqual([250, null]);
  });
});

describe('shippingWeight.resolveTier', () => {
  const tiers = tiersOf(1000, 3000, 5000);

  it('uses inclusive upper bounds and starts the first tier at 0', () => {
    expect(resolveTier(tiers, 0).id).toBe('t0');
    expect(resolveTier(tiers, 1000).id).toBe('t0');
    expect(resolveTier(tiers, 1001).id).toBe('t1');
    expect(resolveTier(tiers, 3000).id).toBe('t1');
    expect(resolveTier(tiers, 5000)).toEqual({ id: 't2', position: 2, fromGrams: 3000, upToGrams: 5000, flags: [] });
  });

  it('charges the last closed tier above it and flags the weight', () => {
    expect(resolveTier(tiers, 5001)).toEqual({
      id: 't2',
      position: 2,
      fromGrams: 3000,
      upToGrams: 5000,
      flags: [OVER_LAST_TIER],
    });
  });

  it('puts everything above the previous bound into an open-ended last tier, unflagged', () => {
    const open = tiersOf(1000, null);
    expect(resolveTier(open, 250000)).toEqual({ id: 't1', position: 1, fromGrams: 1000, upToGrams: null, flags: [] });
  });

  it('is null without tiers or without a weight', () => {
    expect(resolveTier([], 100)).toBeNull();
    expect(resolveTier(tiers, null)).toBeNull();
  });
});

describe('shippingWeight.tierSetErrors', () => {
  it('accepts strictly increasing bounds with an optional open-ended last tier', () => {
    expect(tierSetErrors([{ upToGrams: 1000 }, { upToGrams: 2000 }, { upToGrams: null }])).toEqual([]);
    expect(tierSetErrors([{ upToGrams: null }])).toEqual([]);
  });

  it('refuses an empty set and more than 20 tiers', () => {
    expect(tierSetErrors([])).toHaveLength(1);
    expect(tierSetErrors(Array.from({ length: 21 }, (_, i) => ({ upToGrams: (i + 1) * 100 })))).toHaveLength(1);
  });

  it('refuses equal or decreasing bounds, an open tier before the last, and repeated ids', () => {
    expect(tierSetErrors([{ upToGrams: 1000 }, { upToGrams: 1000 }])[0].field).toBe('tiers.1.upToGrams');
    expect(tierSetErrors([{ upToGrams: 2000 }, { upToGrams: 1000 }])[0].field).toBe('tiers.1.upToGrams');
    expect(tierSetErrors([{ upToGrams: null }, { upToGrams: 1000 }])[0].field).toBe('tiers.0.upToGrams');
    expect(tierSetErrors([{ id: 'a', upToGrams: 1 }, { id: 'a', upToGrams: 2 }])[0].field).toBe('tiers');
  });
});
