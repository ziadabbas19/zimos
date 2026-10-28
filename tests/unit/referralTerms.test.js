'use strict';

// Referral code schedules, the simulator and the email key (referrals/
// referralTerms.js, referrals/emailKey.js, migration 725). Pure: no database.

const terms = require('../../src/modules/referrals/referralTerms');
const { emailKey } = require('../../src/modules/referrals/emailKey');

const pct = (count, value) => ({ count, type: 'percentage', value });
const rate = (count, rateBp) => ({ count, rateBp });
const both = (discount, commission) => ({ monthly: { discount, commission }, yearly: { discount, commission } });

describe('stepAt / discountAt: which payment gets what', () => {
  // First payment free, then 20% for three payments, then nothing.
  const steps = [pct(1, 10000), pct(3, 2000)];

  it('walks the steps by payment number and stops after the last finite one', () => {
    const off = [1, 2, 3, 4, 5, 6].map((paymentNo) => terms.discountAt(steps, { paymentNo, gross: 30000, currency: 'EGP' }));
    expect(off).toEqual([30000, 6000, 6000, 6000, 0, 0]);
    expect(terms.scheduleLength(steps)).toBe(4);
  });

  it('an open-ended last step runs for every payment after it', () => {
    const forever = [pct(1, 10000), pct(null, 1000)];
    expect(terms.discountAt(forever, { paymentNo: 50, gross: 30000, currency: 'EGP' })).toBe(3000);
    expect(terms.scheduleLength(forever)).toBeNull();
  });

  it('a fixed amount only in its own currency, never more than the price; free months at the monthly price', () => {
    const fixed = [{ count: null, type: 'fixed', value: 50000, currency: 'EGP' }];
    expect(terms.discountAt(fixed, { paymentNo: 1, gross: 30000, currency: 'EGP' })).toBe(30000);
    expect(terms.discountAt(fixed, { paymentNo: 1, gross: 30000, currency: 'USD' })).toBe(0);
    const months = [{ count: 1, type: 'free_months', value: 2 }];
    // Yearly 300000 (10 × 30000), two months off = 60000.
    expect(terms.discountAt(months, { paymentNo: 1, gross: 300000, currency: 'EGP', monthlyPrice: 30000 })).toBe(60000);
    expect(terms.discountAt(months, { paymentNo: 2, gross: 300000, currency: 'EGP', monthlyPrice: 30000 })).toBe(0);
  });

  it('rounds a percentage half up, per payment, in minor units', () => {
    // 12.5% of 999 = 124.875 -> 125; 0.01% of 49 = 0.0049 -> 0.
    expect(terms.discountAt([pct(null, 1250)], { paymentNo: 1, gross: 999, currency: 'EGP' })).toBe(125);
    expect(terms.discountAt([pct(null, 1)], { paymentNo: 1, gross: 49, currency: 'EGP' })).toBe(0);
  });
});

describe('commission schedule and basis', () => {
  it('a rate per payment; null once the schedule is over', () => {
    const steps = [rate(1, 10000), rate(12, 3000)];
    expect([1, 2, 13, 14].map((n) => terms.commissionRateAt(steps, n))).toEqual([10000, 3000, 3000, null]);
  });

  it('on what was paid, or on the list price', () => {
    expect(terms.commissionOn({ basis: 'paid', paid: 0, list: 30000, rateBp: 3000 })).toEqual({ base: 0, commission: 0 });
    expect(terms.commissionOn({ basis: 'list', paid: 0, list: 30000, rateBp: 3000 })).toEqual({ base: 30000, commission: 9000 });
  });
});

describe('legacyTerms: a code of the first kind as a schedule', () => {
  it('its discount and its rate (or the default) on every payment, both cycles', () => {
    const t = terms.legacyTerms({ discountType: 'percentage', discountValue: '10000', commissionRateBp: 0 }, 3000);
    expect(t.monthly).toEqual({ discount: [pct(null, 10000)], commission: [rate(null, 0)] });
    expect(t.yearly).toEqual(t.monthly);
    const none = terms.legacyTerms({ discountType: 'none', discountValue: null, commissionRateBp: null }, 3000);
    expect(none.monthly).toEqual({ discount: [], commission: [rate(null, 3000)] });
  });
});

describe('validateTerms', () => {
  it('accepts good terms and keeps only the known keys', () => {
    const good = both([pct(1, 10000), { count: 3, type: 'fixed', value: 500, currency: 'EGP', extra: 1 }], [rate(null, 3000)]);
    expect(terms.validateTerms(good)).toEqual([]);
    expect(terms.normalizeTerms(good).monthly.discount[1]).toEqual({ count: 3, type: 'fixed', value: 500, currency: 'EGP' });
  });

  it('names each bad field', () => {
    const fields = (t) => terms.validateTerms(t).map((e) => e.field);
    expect(fields(null)).toEqual(['terms']);
    expect(fields({ monthly: { discount: [], commission: [] } })).toEqual(['terms.yearly']);
    expect(fields(both([pct(null, 1000), pct(1, 500)], []))).toEqual(['terms.monthly.discount[0].count', 'terms.yearly.discount[0].count']);
    expect(fields(both([pct(1, 10001)], [rate(1, -1)]))).toEqual([
      'terms.monthly.discount[0].value',
      'terms.monthly.commission[0].rateBp',
      'terms.yearly.discount[0].value',
      'terms.yearly.commission[0].rateBp',
    ]);
    expect(fields(both([{ count: 1, type: 'fixed', value: 5 }], []))).toContain('terms.monthly.discount[0].currency');
    expect(fields(both([{ count: 1, type: 'free_months', value: 37 }], []))).toContain('terms.monthly.discount[0].value');
  });

  it('a link schedule is commission steps per cycle', () => {
    expect(terms.validateLinkTerms({ monthly: [rate(null, 2000)], yearly: [rate(12, 1000)] })).toEqual([]);
    expect(terms.validateLinkTerms({ monthly: [rate(null, 2000)] }).map((e) => e.field)).toEqual(['terms.yearly']);
  });
});

describe('simulate', () => {
  // First payment free then 20% for 3; commission 100% of the first, then 30% for 12.
  const t = both([pct(1, 10000), pct(3, 2000)], [rate(1, 10000), rate(12, 3000)]);

  it('on what was paid: a free first payment earns nothing', () => {
    const { rows, totals } = terms.simulate({ terms: t, cycle: 'monthly', gross: 30000, monthlyPrice: 30000, currency: 'EGP' });
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ paymentNo: 1, listPrice: 30000, discount: 30000, merchantPays: 0, commissionRateBp: 10000, commission: 0, platformNet: 0 });
    expect(rows[1]).toEqual({ paymentNo: 2, listPrice: 30000, discount: 6000, merchantPays: 24000, commissionRateBp: 3000, commission: 7200, platformNet: 16800 });
    expect(rows[4]).toEqual({ paymentNo: 5, listPrice: 30000, discount: 0, merchantPays: 30000, commissionRateBp: 3000, commission: 9000, platformNet: 21000 });
    expect(totals.merchantPays).toBe(0 + 3 * 24000 + 8 * 30000);
    expect(totals.platformNet).toBe(totals.merchantPays - totals.commission);
  });

  it('on the list price: the platform pays out on a free payment', () => {
    const { rows } = terms.simulate({ terms: t, cycle: 'monthly', gross: 30000, monthlyPrice: 30000, currency: 'EGP', commissionBasis: 'list' });
    expect(rows[0]).toMatchObject({ merchantPays: 0, commission: 30000, platformNet: -30000 });
    expect(rows[1]).toMatchObject({ merchantPays: 24000, commission: 9000, platformNet: 15000 });
  });

  it('no agent: no commission column', () => {
    const { rows } = terms.simulate({ terms: t, cycle: 'monthly', gross: 30000, monthlyPrice: 30000, currency: 'EGP', hasAgent: false });
    expect(rows.every((r) => r.commission === 0 && r.commissionRateBp === null)).toBe(true);
  });
});

describe('emailKey', () => {
  it('one key for every spelling of one Gmail mailbox', () => {
    const same = ['ab@gmail.com', 'a.b@gmail.com', 'A.B+1@Gmail.com', ' ab+promo@googlemail.com '];
    expect(new Set(same.map(emailKey))).toEqual(new Set(['ab@gmail.com']));
  });

  it('other providers keep their dots but lose the +tag', () => {
    expect(emailKey('A.B+x@Example.com')).toBe('a.b@example.com');
    expect(emailKey('ab@example.com')).not.toBe(emailKey('a.b@example.com'));
    expect(emailKey('')).toBeNull();
  });
});
