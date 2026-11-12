'use strict';

// Cart rewards, the pure rules (modules/cartRewards/cartRewardRules.js): which
// tiers a subtotal reaches, what each is worth, and the single best benefit
// against a code. Amounts are minor units.

const rules = require('../../src/modules/cartRewards/cartRewardRules');

const FREE = { thresholdAmount: 50000, type: 'free_shipping', label: null };
const FIVE = { thresholdAmount: 100000, type: 'percent', value: 5, label: null };
const TEN = { thresholdAmount: 200000, type: 'percent', value: 10, label: null };
const TIERS = [FREE, FIVE, TEN];
const plain = (s) => s.replace(/\s/g, ' ');

describe('progress', () => {
  it('no tier reached: every tier open, the first one next with what it needs', () => {
    const p = rules.progress(TIERS, 20000);
    expect(p.tiers.map((t) => t.reached)).toEqual([false, false, false]);
    expect(p.next).toMatchObject({ index: 0, thresholdAmount: 50000, remainingAmount: 30000, type: 'free_shipping' });
  });

  it('between tiers: the reached ones marked, the next one named', () => {
    const p = rules.progress(TIERS, 120000);
    expect(p.tiers.map((t) => t.reached)).toEqual([true, true, false]);
    expect(p.next).toMatchObject({ index: 2, remainingAmount: 80000, label: { en: '10% off', ar: 'خصم 10%' } });
  });

  it('a subtotal exactly on a threshold reaches it', () => {
    const p = rules.progress(TIERS, 100000);
    expect(p.tiers[1].reached).toBe(true);
    expect(p.next.index).toBe(2);
    expect(rules.progress(TIERS, 99999).tiers[1].reached).toBe(false);
  });

  it('all reached: nothing next', () => {
    expect(rules.progress(TIERS, 999999).next).toBeNull();
  });

  it('an empty cart: nothing reached, the whole first threshold to go', () => {
    expect(rules.progress(TIERS, 0).next.remainingAmount).toBe(50000);
  });

  it('lists the tiers lowest first whatever their order', () => {
    expect(rules.progress([TEN, FREE, FIVE], 0).tiers.map((t) => t.thresholdAmount)).toEqual([50000, 100000, 200000]);
  });
});

describe('what a discount tier takes off', () => {
  it('a percentage rounds half up to the minor unit', () => {
    expect(rules.discountOf({ type: 'percent', value: 5 }, 1010)).toBe(51); // 50.5
    expect(rules.discountOf({ type: 'percent', value: 5 }, 1009)).toBe(50); // 50.45
    expect(rules.discountOf({ type: 'percent', value: 15 }, 333)).toBe(50); // 49.95
    expect(rules.discountOf({ type: 'percent', value: 100 }, 777)).toBe(777);
  });

  it('a fixed amount never takes more than the subtotal; free shipping takes nothing off the items', () => {
    expect(rules.discountOf({ type: 'fixed', value: 5000 }, 3000)).toBe(3000);
    expect(rules.discountOf({ type: 'fixed', value: 5000 }, 9000)).toBe(5000);
    expect(rules.discountOf(FREE, 90000)).toBe(0);
  });
});

describe('the best tier', () => {
  it('nothing reached: no reward', () => {
    expect(rules.bestTierReward(TIERS, 1000, 5000)).toEqual({ reward: null, notes: [] });
  });

  it('the discount that takes the most off, not merely the highest threshold', () => {
    const tiers = [
      { thresholdAmount: 100000, type: 'fixed', value: 20000, label: null },
      { thresholdAmount: 150000, type: 'percent', value: 5, label: null },
    ];
    const { reward } = rules.bestTierReward(tiers, 160000, null);
    expect(reward).toMatchObject({ type: 'fixed', amount: 20000 });
  });

  it('free shipping when the fee is worth more than the discount reached', () => {
    const { reward, notes } = rules.bestTierReward(TIERS, 100000, 6000);
    expect(reward).toMatchObject({ type: 'free_shipping', amount: 6000, freeShipping: true });
    expect(notes).toEqual([]);
  });

  it('the discount, with a note, when it saves more than free shipping', () => {
    const { reward, notes } = rules.bestTierReward(TIERS, 200000, 6000);
    expect(reward).toMatchObject({ type: 'percent', value: 10, amount: 20000, freeShipping: false });
    expect(notes).toEqual([rules.NOTES.DISCOUNT_OVER_FREE_SHIPPING]);
  });

  it('a tie goes to free shipping', () => {
    const { reward } = rules.bestTierReward(TIERS, 100000, 5000);
    expect(reward.type).toBe('free_shipping');
  });

  it('a fee not known yet: a reached discount shows, without the note', () => {
    const { reward, notes } = rules.bestTierReward(TIERS, 100000, null);
    expect(reward).toMatchObject({ type: 'percent', amount: 5000 });
    expect(notes).toEqual([]);
  });

  it('only free shipping reached: it, worth the fee', () => {
    expect(rules.bestTierReward(TIERS, 60000, 4500).reward).toMatchObject({ type: 'free_shipping', amount: 4500 });
  });

  it('shipping already free (fee 0): the discount, and no note', () => {
    const { reward, notes } = rules.bestTierReward(TIERS, 100000, 0);
    expect(reward.type).toBe('percent');
    expect(notes).toEqual([]);
  });
});

describe('the reward against a code', () => {
  const reward = { type: 'percent', value: 10, amount: 20000, freeShipping: false };

  it('no code: the reward', () => {
    expect(rules.chooseBenefit({ reward, coupon: null, allowCouponStacking: false })).toEqual({ reward, keepCoupon: false, notes: [] });
  });

  it('no reward: the code stays', () => {
    expect(rules.chooseBenefit({ reward: null, coupon: { value: 100 }, allowCouponStacking: false })).toMatchObject({ reward: null, keepCoupon: true });
  });

  it('not combined: the bigger one wins, the other is left out', () => {
    expect(rules.chooseBenefit({ reward, coupon: { value: 15000 }, allowCouponStacking: false })).toEqual({ reward, keepCoupon: false, notes: ['reward_over_coupon'] });
    expect(rules.chooseBenefit({ reward, coupon: { value: 25000 }, allowCouponStacking: false })).toEqual({ reward: null, keepCoupon: true, notes: ['coupon_over_reward'] });
  });

  it('not combined, a tie: the code stays', () => {
    expect(rules.chooseBenefit({ reward, coupon: { value: 20000 }, allowCouponStacking: false })).toMatchObject({ reward: null, keepCoupon: true });
  });

  it('combined: both apply', () => {
    expect(rules.chooseBenefit({ reward, coupon: { value: 99999 }, allowCouponStacking: true })).toEqual({ reward, keepCoupon: true, notes: [] });
  });

  it('combined, free shipping twice: the code alone', () => {
    const free = { type: 'free_shipping', amount: 5000, freeShipping: true };
    expect(rules.chooseBenefit({ reward: free, coupon: { value: 5000, freeShipping: true }, allowCouponStacking: true })).toMatchObject({ reward: null, keepCoupon: true });
  });
});

describe('the settings checks', () => {
  it('thresholds must rise within each kind, in the order listed', () => {
    expect(rules.tierErrors(TIERS)).toEqual([]);
    // A discount and free shipping may share a threshold.
    expect(rules.tierErrors([FREE, { ...FIVE, thresholdAmount: 50000 }])).toEqual([]);
    expect(rules.tierErrors([FIVE, { ...TEN, thresholdAmount: 100000 }])).toEqual([
      expect.objectContaining({ field: 'tiers.1.thresholdAmount' }),
    ]);
    expect(rules.tierErrors([TEN, FIVE])).toEqual([expect.objectContaining({ field: 'tiers.1.thresholdAmount' })]);
    // Percent and fixed are the same kind (discounts).
    expect(rules.tierErrors([TEN, { thresholdAmount: 150000, type: 'fixed', value: 100 }])).toHaveLength(1);
  });
});

describe('names', () => {
  it('the automatic ones, in both languages and the store currency', () => {
    expect(rules.autoLabel(FREE)).toEqual({ en: 'Free shipping', ar: 'شحن مجاني' });
    expect(rules.autoLabel(FIVE)).toEqual({ en: '5% off', ar: 'خصم 5%' });
    expect(plain(rules.autoLabel({ type: 'fixed', value: 5000 }, 'EGP').en)).toBe('EGP 50 off');
    expect(plain(rules.autoLabel({ type: 'fixed', value: 5050 }, 'EGP').en)).toBe('EGP 50.50 off');
    // A currency with no minor digits, and one with three.
    expect(rules.autoLabel({ type: 'fixed', value: 500 }, 'JPY').en).toContain('500');
    expect(plain(rules.autoLabel({ type: 'fixed', value: 1500 }, 'KWD').en)).toBe('KWD 1.500 off');
  });

  it("the merchant's own name wins, per language", () => {
    expect(rules.labelOf({ ...FIVE, label: { ar: 'هدية الشتاء', en: '' } })).toEqual({ ar: 'هدية الشتاء', en: '5% off' });
  });
});

describe('what an order was given', () => {
  it('its snapshot entry, and the part of it taken off the items', () => {
    const entry = rules.snapshotEntry({ type: 'percent', value: 10, thresholdAmount: 200000, label: { ar: 'خصم 10%', en: '10% off' }, amount: 20000, freeShipping: false });
    expect(entry).toEqual({ kind: 'cart_reward', rewardType: 'percent', value: 10, thresholdAmount: 200000, label: { ar: 'خصم 10%', en: '10% off' }, amount: 20000, freeShipping: false });
    expect(rules.placedRewardDiscount([{ kind: 'bundle', amount: 100 }, entry])).toBe(20000);
    expect(rules.placedRewardDiscount([{ ...entry, freeShipping: true }])).toBe(0);
    expect(rules.placedRewardShipsFree([{ ...entry, freeShipping: true }])).toBe(true);
  });
});
