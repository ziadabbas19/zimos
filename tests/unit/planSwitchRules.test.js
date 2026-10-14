'use strict';

const rules = require('../../src/modules/billing/planSwitchRules');

// A merchant switching plan by themselves (billing/planSwitchRules): what a
// request is, what an upgrade's remaining days cost, and whether a switch
// still fits the store when its payment or its moment comes. No database.

const DAY = 24 * 60 * 60 * 1000;
const at = (iso) => new Date(iso);
const plan = (id, monthly, extra = {}) => ({ id, monthlyPriceAmount: monthly, currency: 'EGP', perOrderFeeAmount: 0, ...extra });

const BASIC = plan('basic', 30000);
const PRO = plan('pro', 60000);
const BUSINESS = plan('business', 90000);
const FREE = plan('free', 0);
const DOLLAR = plan('dollar', 2000, { currency: 'USD' });
const FEE = plan('ppo', 0, { perOrderFeeAmount: 400 });

// A March period: 31 days, paid monthly.
const paid = (extra = {}) => ({
  status: 'active',
  planId: BASIC.id,
  billingCycle: 'monthly',
  pricingKind: 'paid',
  currentPeriodStart: at('2026-03-01T00:00:00Z'),
  currentPeriodEnd: at('2026-04-01T00:00:00Z'),
  ...extra,
});

describe('periodTerms', () => {
  it('reads a paid month or year from the period itself', () => {
    expect(rules.periodTerms({ periodStart: at('2026-02-01T00:00:00Z'), periodEnd: at('2026-03-01T00:00:00Z'), billingCycle: 'yearly' })).toEqual({
      cycle: 'monthly',
      cycleDays: 28,
      standard: true,
    });
    // 33 days is no month: a period set by hand.
    expect(rules.periodTerms({ periodStart: at('2026-01-31T10:00:00Z'), periodEnd: at('2026-03-05T10:00:00Z'), billingCycle: 'monthly' }).standard).toBe(false);
    expect(rules.periodTerms({ periodStart: at('2027-03-01T00:00:00Z'), periodEnd: at('2028-03-01T00:00:00Z'), billingCycle: 'monthly' })).toEqual({
      cycle: 'yearly',
      cycleDays: 366,
      standard: true,
    });
  });

  it('prices a period set by hand per nominal day of the stored cycle', () => {
    const quarter = { periodStart: at('2026-03-01T00:00:00Z'), periodEnd: at('2026-05-30T00:00:00Z') };
    expect(rules.periodTerms({ ...quarter, billingCycle: 'monthly' })).toEqual({ cycle: 'monthly', cycleDays: 30, standard: false });
    expect(rules.periodTerms({ ...quarter, billingCycle: 'yearly' })).toEqual({ cycle: 'yearly', cycleDays: 365, standard: false });
  });
});

describe('remainingDays', () => {
  it('counts today as a whole day and nothing once the period has passed', () => {
    const end = at('2026-04-01T00:00:00Z');
    expect(rules.remainingDays(end, at('2026-03-01T00:00:00Z'))).toBe(31);
    expect(rules.remainingDays(end, at('2026-03-31T23:59:59Z'))).toBe(1);
    expect(rules.remainingDays(end, at('2026-03-17T12:00:00Z'))).toBe(15);
    expect(rules.remainingDays(end, end)).toBe(0);
    expect(rules.remainingDays(end, at('2026-04-03T00:00:00Z'))).toBe(0);
  });
});

describe('prorate', () => {
  it('charges the difference for the days left, rounded half up to whole units', () => {
    // 30000 × 15 / 31 = 14516.13 → EGP 145.16 → 145
    expect(rules.prorate({ fromPrice: 30000, toPrice: 60000, days: 15, cycleDays: 31 })).toEqual({ difference: 30000, amount: 14500 });
    // A full period left is the whole difference.
    expect(rules.prorate({ fromPrice: 30000, toPrice: 60000, days: 31, cycleDays: 31 })).toEqual({ difference: 30000, amount: 30000 });
    // 15000 × 1 / 30 = 500 minor = EGP 5.00
    expect(rules.prorate({ fromPrice: 15000, toPrice: 30000, days: 1, cycleDays: 30 }).amount).toBe(500);
    // 50 minor exactly half a unit: rounds up.
    expect(rules.prorate({ fromPrice: 0, toPrice: 1500, days: 1, cycleDays: 30 }).amount).toBe(100);
    // Under half a unit: nothing.
    expect(rules.prorate({ fromPrice: 0, toPrice: 1400, days: 1, cycleDays: 30 }).amount).toBe(0);
  });

  it('charges nothing for a cheaper or equal plan, or with no day left', () => {
    expect(rules.prorate({ fromPrice: 60000, toPrice: 30000, days: 10, cycleDays: 30 })).toEqual({ difference: -30000, amount: 0 });
    expect(rules.prorate({ fromPrice: 30000, toPrice: 30000, days: 10, cycleDays: 30 }).amount).toBe(0);
    expect(rules.prorate({ fromPrice: 30000, toPrice: 60000, days: 0, cycleDays: 30 }).amount).toBe(0);
  });

  it('charges more than one period when more than one is paid ahead (a renewal paid early)', () => {
    expect(rules.prorate({ fromPrice: 30000, toPrice: 60000, days: 45, cycleDays: 30 }).amount).toBe(45000);
  });

  it('refuses what is not a whole, non-negative amount', () => {
    expect(() => rules.prorate({ fromPrice: 1.5, toPrice: 2, days: 1, cycleDays: 30 })).toThrow(TypeError);
    expect(() => rules.prorate({ fromPrice: 1, toPrice: 2, days: -1, cycleDays: 30 })).toThrow(TypeError);
    expect(() => rules.prorate({ fromPrice: 1, toPrice: 2, days: 1, cycleDays: 0 })).toThrow(TypeError);
    expect(() => rules.prorate({ fromPrice: 0, toPrice: Number.MAX_SAFE_INTEGER, days: 400, cycleDays: 30 })).toThrow(RangeError);
  });
});

describe('decide', () => {
  const now = at('2026-03-17T12:00:00Z'); // 15 days left of March

  it('an upgrade inside a paid period costs the difference for the days left', () => {
    const d = rules.decide({ subscription: paid(), current: BASIC, target: PRO, targetCycle: 'monthly', now });
    expect(d).toEqual({
      kind: 'upgrade',
      proration: {
        remainingDays: 15,
        cycleDays: 31,
        periodCycle: 'monthly',
        standardPeriod: true,
        fromPrice: 30000,
        toPrice: 60000,
        difference: 30000,
        amount: 14500,
        currency: 'EGP',
      },
    });
  });

  it('prices the upgrade on the cycle the period was paid on, whatever cycle comes next', () => {
    const d = rules.decide({ subscription: paid(), current: BASIC, target: PRO, targetCycle: 'yearly', now });
    expect(d.kind).toBe('upgrade');
    expect(d.proration).toMatchObject({ periodCycle: 'monthly', fromPrice: 30000, toPrice: 60000, amount: 14500 });
    // A yearly period: the yearly prices (10 × monthly).
    const yearly = paid({ billingCycle: 'yearly', currentPeriodStart: at('2026-01-01T00:00:00Z'), currentPeriodEnd: at('2027-01-01T00:00:00Z') });
    const y = rules.decide({ subscription: yearly, current: BASIC, target: PRO, targetCycle: 'yearly', now });
    // 300000 × 290 / 365 = 238356.16 → 238400
    expect(y.proration).toMatchObject({ periodCycle: 'yearly', cycleDays: 365, remainingDays: 290, fromPrice: 300000, toPrice: 600000, amount: 238400 });
  });

  it('compares the prices the merchant pays, after the referral code', () => {
    const tenPercentOff = (p, cycle) => {
      const gross = cycle === 'yearly' ? p.monthlyPriceAmount * 10 : p.monthlyPriceAmount;
      return gross - Math.round(gross / 10);
    };
    const d = rules.decide({ subscription: paid(), current: BASIC, target: PRO, targetCycle: 'monthly', now, price: tenPercentOff });
    // (54000 − 27000) × 15 / 31 = 13064.5 → 13100
    expect(d.proration).toMatchObject({ fromPrice: 27000, toPrice: 54000, amount: 13100 });
    // A code that makes both free: the same price, so nothing to pay.
    const huge = () => 0;
    expect(rules.decide({ subscription: paid(), current: BASIC, target: PRO, targetCycle: 'monthly', now, price: huge })).toEqual({
      kind: 'immediate',
      reason: 'same_price',
      free: false,
    });
  });

  it('a downgrade waits for the end of the paid period', () => {
    const d = rules.decide({ subscription: paid({ planId: PRO.id }), current: PRO, target: BASIC, targetCycle: 'monthly', now });
    expect(d).toEqual({ kind: 'scheduled', reason: 'downgrade', effectiveAt: at('2026-04-01T00:00:00Z'), free: false });
    const toFree = rules.decide({ subscription: paid({ planId: PRO.id }), current: PRO, target: FREE, targetCycle: 'monthly', now });
    expect(toFree).toMatchObject({ kind: 'scheduled', reason: 'downgrade', free: true });
  });

  it('a cycle change alone, or another currency, waits for the end of the period too', () => {
    expect(rules.decide({ subscription: paid(), current: BASIC, target: BASIC, targetCycle: 'yearly', now })).toEqual({
      kind: 'scheduled',
      reason: 'cycle_change',
      effectiveAt: at('2026-04-01T00:00:00Z'),
      free: false,
    });
    expect(rules.decide({ subscription: paid(), current: BASIC, target: DOLLAR, targetCycle: 'monthly', now })).toMatchObject({
      kind: 'scheduled',
      reason: 'currency',
    });
    // A dollar store upgrading within dollars is priced as any upgrade.
    const dollarPro = plan('dollar-pro', 5000, { currency: 'USD' });
    const usd = rules.decide({ subscription: paid({ planId: DOLLAR.id }), current: DOLLAR, target: dollarPro, targetCycle: 'monthly', now });
    expect(usd).toMatchObject({ kind: 'upgrade', proration: { currency: 'USD', amount: 1500 } });
  });

  it('a period that has ended changes at once, up or down, with nothing to pay', () => {
    const ended = paid({ currentPeriodEnd: at('2026-03-10T00:00:00Z') });
    expect(rules.decide({ subscription: ended, current: BASIC, target: PRO, targetCycle: 'monthly', now })).toEqual({
      kind: 'immediate',
      reason: 'period_ended',
      free: false,
    });
    // Stored past_due (a lapsed or failed renewal) is judged by its period the same way.
    expect(rules.decide({ subscription: { ...ended, status: 'past_due' }, current: PRO, target: FREE, targetCycle: 'monthly', now })).toEqual({
      kind: 'immediate',
      reason: 'period_ended',
      free: true,
    });
  });

  it('the same plan and cycle is nothing; the same price is a change with nothing to pay', () => {
    expect(rules.decide({ subscription: paid(), current: BASIC, target: BASIC, targetCycle: 'monthly', now })).toEqual({ kind: 'none' });
    expect(rules.decide({ subscription: paid(), current: BASIC, target: BASIC, now })).toEqual({ kind: 'none' });
    const twin = plan('twin', 30000);
    expect(rules.decide({ subscription: paid(), current: BASIC, target: twin, targetCycle: 'yearly', now })).toEqual({
      kind: 'immediate',
      reason: 'same_price',
      free: false,
    });
  });

  it('an upgrade worth less than half a unit is a change with nothing to pay', () => {
    const lastHour = at('2026-03-31T23:00:00Z');
    const cent = plan('cent', 30001);
    const d = rules.decide({ subscription: paid(), current: BASIC, target: cent, targetCycle: 'monthly', now: lastHour });
    expect(d).toMatchObject({ kind: 'immediate', reason: 'nothing_due', free: false, proration: { amount: 0, remainingDays: 1 } });
  });

  it('from a free plan, a paid plan is a full period from its payment', () => {
    const freeSub = paid({ planId: FREE.id, currentPeriodStart: at('2026-01-01T00:00:00Z'), currentPeriodEnd: at('2126-01-01T00:00:00Z') });
    expect(rules.decide({ subscription: freeSub, current: FREE, target: PRO, targetCycle: 'monthly', now })).toEqual({ kind: 'move', reason: 'from_free' });
    const otherFree = plan('free-2', 0);
    expect(rules.decide({ subscription: freeSub, current: FREE, target: otherFree, targetCycle: 'monthly', now })).toEqual({
      kind: 'immediate',
      reason: 'free_plan',
      free: true,
    });
  });

  it('leaves drafts, trials and pay per order to their own paths', () => {
    expect(rules.decide({ subscription: paid({ status: 'trialing' }), current: BASIC, target: PRO, now })).toEqual({ kind: 'trial_change' });
    expect(rules.decide({ subscription: paid({ status: 'draft' }), current: BASIC, target: PRO, now })).toEqual({ kind: 'trial_change' });
    expect(rules.decide({ subscription: paid({ planId: FEE.id }), current: FEE, target: PRO, now })).toEqual({ kind: 'pay_per_order' });
  });

  it('refuses what support decides: closed, priced by hand, special terms', () => {
    expect(rules.decide({ subscription: paid({ status: 'cancelled' }), current: BASIC, target: PRO, now })).toEqual({ refuse: 'PLAN_CHANGE_NEEDS_SUPPORT' });
    expect(rules.decide({ subscription: paid({ status: 'suspended' }), current: BASIC, target: PRO, now })).toEqual({ refuse: 'PLAN_CHANGE_NEEDS_SUPPORT' });
    expect(rules.decide({ subscription: paid({ pricingKind: 'free' }), current: BASIC, target: PRO, now })).toEqual({ refuse: 'MANUAL_PRICING' });
    expect(rules.decide({ subscription: paid({ pricingKind: 'discounted' }), current: BASIC, target: BASIC, now })).toEqual({ refuse: 'MANUAL_PRICING' });
    expect(rules.decide({ subscription: paid(), current: BASIC, target: PRO, now, specialTerms: true })).toEqual({ refuse: 'SPECIAL_TERMS_ACTIVE' });
  });

  it('prices a period set by hand per nominal day', () => {
    // An admin-granted 90-day period, monthly: 60 days left = two months of difference.
    const manual = paid({ currentPeriodStart: at('2026-02-15T12:00:00Z'), currentPeriodEnd: at('2026-05-16T12:00:00Z') });
    const d = rules.decide({ subscription: manual, current: BASIC, target: PRO, targetCycle: 'monthly', now });
    expect(d.proration).toMatchObject({ standardPeriod: false, cycleDays: 30, remainingDays: 60, amount: 60000 });
  });

  it('with no plan on the subscription, the plan is set at once', () => {
    expect(rules.decide({ subscription: paid({ planId: null }), current: null, target: PRO, now })).toEqual({ kind: 'immediate', reason: 'no_plan', free: false });
  });
});

describe('selfServeMode', () => {
  it('names the way each subscription changes plan', () => {
    expect(rules.selfServeMode({ subscription: paid({ status: 'trialing' }), current: BASIC })).toEqual({ mode: 'immediate', reason: null });
    expect(rules.selfServeMode({ subscription: paid({ status: 'draft' }), current: BASIC })).toEqual({ mode: 'immediate', reason: null });
    expect(rules.selfServeMode({ subscription: paid(), current: FEE })).toEqual({ mode: 'move', reason: null });
    expect(rules.selfServeMode({ subscription: paid(), current: BASIC })).toEqual({ mode: 'switch', reason: null });
    // An ended period is still self-serve: the plan then changes at once.
    expect(rules.selfServeMode({ subscription: paid({ status: 'past_due' }), current: BASIC })).toEqual({ mode: 'switch', reason: null });
    expect(rules.selfServeMode({ subscription: paid({ status: 'cancelled' }), current: BASIC })).toEqual({ mode: 'support', reason: 'PLAN_CHANGE_NEEDS_SUPPORT' });
    expect(rules.selfServeMode({ subscription: paid({ pricingKind: 'free' }), current: BASIC })).toEqual({ mode: 'support', reason: 'MANUAL_PRICING' });
    expect(rules.selfServeMode({ subscription: paid(), current: BASIC, specialTerms: true })).toEqual({ mode: 'support', reason: 'SPECIAL_TERMS_ACTIVE' });
  });
});

describe('chargeStillApplies', () => {
  const sw = { kind: 'upgrade', fromPlanId: BASIC.id, fromBillingCycle: 'monthly', toPlanId: PRO.id };
  const invoice = { periodEnd: at('2026-04-01T00:00:00Z') };

  it('applies while the store is as it was priced', () => {
    expect(rules.chargeStillApplies({ subscription: paid(), sw, invoice })).toEqual({ applies: true, reason: null });
    // An ended period does not stop a paid upgrade: the plan still changes.
    expect(rules.chargeStillApplies({ subscription: paid({ status: 'past_due' }), sw, invoice }).applies).toBe(true);
  });

  it('does not apply once the plan, the cycle or the period moved under it', () => {
    expect(rules.chargeStillApplies({ subscription: paid({ planId: PRO.id }), sw, invoice }).reason).toBe('plan_changed');
    expect(rules.chargeStillApplies({ subscription: paid({ billingCycle: 'yearly' }), sw, invoice }).reason).toBe('plan_changed');
    const renewed = paid({ currentPeriodEnd: at('2026-05-01T00:00:00Z') });
    expect(rules.chargeStillApplies({ subscription: renewed, sw, invoice }).reason).toBe('period_renewed');
    // A full-period move from a free plan does not care about the old period.
    expect(rules.chargeStillApplies({ subscription: renewed, sw: { ...sw, kind: 'move' }, invoice }).applies).toBe(true);
    expect(rules.chargeStillApplies({ subscription: paid(), sw: { ...sw, toPlanId: null }, invoice }).reason).toBe('plan_gone');
    expect(rules.chargeStillApplies({ subscription: paid({ status: 'cancelled' }), sw, invoice }).reason).toBe('subscription_closed');
    expect(rules.chargeStillApplies({ subscription: paid({ pricingKind: 'free' }), sw, invoice }).reason).toBe('manual_pricing');
  });

  it('a late payment also needs the plan on offer and nothing else waiting', () => {
    const base = { subscription: paid(), sw, invoice, late: true };
    expect(rules.chargeStillApplies(base).applies).toBe(true);
    expect(rules.chargeStillApplies({ ...base, targetOffered: false }).reason).toBe('plan_not_offered');
    expect(rules.chargeStillApplies({ ...base, otherPending: true }).reason).toBe('other_charge_pending');
    expect(rules.chargeStillApplies({ ...base, otherOpen: true }).reason).toBe('other_switch_open');
    // Not late: those three are not asked.
    expect(rules.chargeStillApplies({ ...base, late: false, targetOffered: false, otherPending: true }).applies).toBe(true);
  });
});

describe('scheduleStillApplies and scheduleCovers', () => {
  const sw = { kind: 'scheduled', fromPlanId: PRO.id, fromBillingCycle: 'monthly', toPlanId: BASIC.id };

  it('applies while the store is on the plan and cycle it was asked from', () => {
    expect(rules.scheduleStillApplies({ subscription: paid({ planId: PRO.id }), sw, targetExists: true })).toEqual({ applies: true, reason: null });
    expect(rules.scheduleStillApplies({ subscription: paid({ planId: FEE.id }), sw, targetExists: true }).reason).toBe('plan_changed');
    expect(rules.scheduleStillApplies({ subscription: paid({ planId: PRO.id }), sw, targetExists: false }).reason).toBe('plan_gone');
    expect(rules.scheduleStillApplies({ subscription: paid({ planId: PRO.id, pricingKind: 'discounted' }), sw, targetExists: true }).reason).toBe('manual_pricing');
    expect(rules.scheduleStillApplies({ subscription: paid({ planId: PRO.id, status: 'suspended' }), sw, targetExists: true }).reason).toBe('subscription_closed');
  });

  it('prices the charge for the period that starts at its moment, not one before', () => {
    const effectiveAt = at('2026-04-01T00:00:00Z');
    expect(rules.scheduleCovers(effectiveAt, at('2026-04-01T00:00:00Z'))).toBe(true);
    expect(rules.scheduleCovers(effectiveAt, at('2026-03-31T23:59:59.500Z'))).toBe(true);
    expect(rules.scheduleCovers(effectiveAt, at('2026-04-20T00:00:00Z'))).toBe(true);
    expect(rules.scheduleCovers(effectiveAt, at('2026-03-20T00:00:00Z'))).toBe(false);
  });

  it('an unpaid charge expires its hours after it was made', () => {
    expect(rules.expiresAt(at('2026-03-01T00:00:00Z'), 48)).toEqual(new Date(at('2026-03-01T00:00:00Z').getTime() + 2 * DAY));
  });
});

describe('chargeExpiry', () => {
  const now = at('2026-03-17T12:00:00Z');
  const base = { now, switchHours: 48, moveHours: 72, walletEnabled: true };

  it('an upgrade or a move from a free plan: the switch hours, from now', () => {
    expect(rules.chargeExpiry({ ...base, kind: 'upgrade' })).toEqual({ hours: 48, expiresAt: at('2026-03-19T12:00:00Z') });
    expect(rules.chargeExpiry({ ...base, kind: 'move' })).toEqual({ hours: 48, expiresAt: at('2026-03-19T12:00:00Z') });
    expect(rules.chargeExpiry({ ...base, kind: 'upgrade', switchHours: 1 })).toEqual({ hours: 1, expiresAt: at('2026-03-17T13:00:00Z') });
  });

  it('a pay-per-order move: its own hours, and none while the wallet is off', () => {
    expect(rules.chargeExpiry({ ...base, kind: 'pay_per_order' })).toEqual({ hours: 72, expiresAt: at('2026-03-20T12:00:00Z') });
    expect(rules.chargeExpiry({ ...base, kind: 'pay_per_order', walletEnabled: false })).toBeNull();
  });

  it('a switch that writes no charge: none', () => {
    for (const kind of ['scheduled', 'immediate', 'trial_change', 'none']) expect(rules.chargeExpiry({ ...base, kind })).toBeNull();
  });
});
