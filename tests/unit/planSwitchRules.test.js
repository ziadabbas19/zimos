'use strict';

const rules = require('../../src/modules/billing/planSwitchRules');

// A merchant switching plan by themselves (billing/planSwitchRules): what a
// request is, when it may take effect, and whether a switch
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

describe('decide', () => {
  const now = at('2026-03-17T12:00:00Z'); // 15 days left of March

  it('an upgrade inside a paid period offers its two timings, with no price worked out here', () => {
    expect(rules.decide({ subscription: paid(), current: BASIC, target: PRO, targetCycle: 'monthly', now })).toEqual({
      kind: 'upgrade',
      reason: 'upgrade',
      timings: ['now', 'period_end'],
      effectiveAt: at('2026-04-01T00:00:00Z'),
    });
    // On a yearly period, and to another cycle: the same two timings.
    const yearly = paid({ billingCycle: 'yearly', currentPeriodStart: at('2026-01-01T00:00:00Z'), currentPeriodEnd: at('2027-01-01T00:00:00Z') });
    expect(rules.decide({ subscription: yearly, current: BASIC, target: PRO, targetCycle: 'monthly', now })).toMatchObject({
      kind: 'upgrade',
      timings: ['now', 'period_end'],
      effectiveAt: at('2027-01-01T00:00:00Z'),
    });
  });

  it('compares the prices the merchant pays, after the referral code', () => {
    const huge = () => 0;
    // A code that makes both free: the same price, so nothing to pay.
    expect(rules.decide({ subscription: paid(), current: BASIC, target: PRO, targetCycle: 'monthly', now, price: huge })).toEqual({
      kind: 'immediate',
      reason: 'same_price',
      free: false,
    });
    // A code that makes only the new plan free: nothing is due for it.
    const onlyPro = (p) => (p.id === 'pro' ? 0 : p.monthlyPriceAmount);
    const cheaperNow = rules.decide({ subscription: paid(), current: BASIC, target: PRO, targetCycle: 'monthly', now, price: onlyPro });
    expect(cheaperNow).toMatchObject({ kind: 'scheduled', reason: 'downgrade' });
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
    // A dollar store upgrading within dollars is an upgrade as any other.
    const dollarPro = plan('dollar-pro', 5000, { currency: 'USD' });
    expect(rules.decide({ subscription: paid({ planId: DOLLAR.id }), current: DOLLAR, target: dollarPro, targetCycle: 'monthly', now })).toMatchObject({
      kind: 'upgrade',
    });
  });

  it('a period that has ended changes at once, up or down, with nothing to pay', () => {
    const ended = paid({ currentPeriodEnd: at('2026-03-10T00:00:00Z') });
    expect(rules.decide({ subscription: ended, current: BASIC, target: PRO, targetCycle: 'monthly', now })).toEqual({
      kind: 'immediate',
      reason: 'period_ended',
      free: false,
      payPerOrder: false,
    });
    expect(rules.decide({ subscription: { ...ended, status: 'past_due' }, current: PRO, target: FREE, targetCycle: 'monthly', now })).toEqual({
      kind: 'immediate',
      reason: 'period_ended',
      free: true,
      payPerOrder: false,
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

  it('with no plan on the subscription, the plan is set at once', () => {
    expect(rules.decide({ subscription: paid({ planId: null }), current: null, target: PRO, now })).toEqual({
      kind: 'immediate',
      reason: 'no_plan',
      free: false,
      payPerOrder: false,
    });
  });
});

describe('decide: to pay per order', () => {
  const now = at('2026-03-17T12:00:00Z');

  it('a paid subscription moves at the end of its paid period, like a downgrade', () => {
    expect(rules.decide({ subscription: paid(), current: BASIC, target: FEE, targetCycle: 'yearly', now })).toEqual({
      kind: 'scheduled',
      reason: 'to_pay_per_order',
      effectiveAt: at('2026-04-01T00:00:00Z'),
      free: false,
      payPerOrder: true,
    });
  });

  it('a period that has ended, or a free plan, moves now', () => {
    const ended = paid({ currentPeriodEnd: at('2026-03-10T00:00:00Z') });
    expect(rules.decide({ subscription: ended, current: BASIC, target: FEE, now })).toEqual({
      kind: 'immediate',
      reason: 'to_pay_per_order',
      free: false,
      payPerOrder: true,
    });
    const freeSub = paid({ planId: FREE.id, currentPeriodEnd: at('2126-01-01T00:00:00Z') });
    expect(rules.decide({ subscription: freeSub, current: FREE, target: FEE, now })).toMatchObject({ kind: 'immediate', reason: 'to_pay_per_order', payPerOrder: true });
  });

  it('support still decides for prices set by hand, special terms and closed subscriptions', () => {
    expect(rules.decide({ subscription: paid({ pricingKind: 'discounted' }), current: BASIC, target: FEE, now })).toEqual({ refuse: 'MANUAL_PRICING' });
    expect(rules.decide({ subscription: paid(), current: BASIC, target: FEE, now, specialTerms: true })).toEqual({ refuse: 'SPECIAL_TERMS_ACTIVE' });
    expect(rules.decide({ subscription: paid({ status: 'suspended' }), current: BASIC, target: FEE, now })).toEqual({ refuse: 'PLAN_CHANGE_NEEDS_SUPPORT' });
  });

  it('is not a switch for a draft or a trial (they choose it from its card), and none for a store already on it', () => {
    expect(rules.decide({ subscription: paid({ status: 'trialing' }), current: BASIC, target: FEE, now })).toEqual({ unavailable: true });
    expect(rules.decide({ subscription: paid({ status: 'draft' }), current: BASIC, target: FEE, now })).toEqual({ unavailable: true });
    expect(rules.decide({ subscription: paid({ planId: FEE.id }), current: FEE, target: FEE, now })).toEqual({ kind: 'none' });
    const otherFee = plan('ppo-2', 0, { perOrderFeeAmount: 300 });
    expect(rules.decide({ subscription: paid({ planId: FEE.id }), current: FEE, target: otherFee, now })).toEqual({ unavailable: true });
  });
});

describe('resolveTiming', () => {
  const upgrade = { kind: 'upgrade', timings: ['now', 'period_end'], effectiveAt: at('2026-04-01T00:00:00Z') };

  it('an upgrade is "now" by default, and "period_end" makes it a scheduled switch', () => {
    expect(rules.resolveTiming(upgrade)).toEqual({ timing: 'now', kind: 'upgrade', available: ['now', 'period_end'] });
    expect(rules.resolveTiming(upgrade, 'now')).toEqual({ timing: 'now', kind: 'upgrade', available: ['now', 'period_end'] });
    expect(rules.resolveTiming(upgrade, 'period_end')).toEqual({ timing: 'period_end', kind: 'scheduled', available: ['now', 'period_end'] });
  });

  it('a scheduled switch only at the period end; anything else only now', () => {
    const down = { kind: 'scheduled', reason: 'downgrade', effectiveAt: at('2026-04-01T00:00:00Z') };
    expect(rules.resolveTiming(down)).toEqual({ timing: 'period_end', kind: 'scheduled', available: ['period_end'] });
    expect(rules.resolveTiming(down, 'now')).toEqual({ error: 'SWITCH_TIMING_NOT_AVAILABLE', available: ['period_end'] });
    for (const kind of ['immediate', 'move', 'none', 'trial_change', 'pay_per_order']) {
      expect(rules.resolveTiming({ kind })).toMatchObject({ timing: 'now', kind, available: ['now'] });
      expect(rules.resolveTiming({ kind }, 'period_end')).toEqual({ error: 'SWITCH_TIMING_NOT_AVAILABLE', available: ['now'] });
    }
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

  it('a full-period upgrade starts its own period, so a later renewal of the old plan does not stop it', () => {
    const full = { ...sw, quote: { pricing: 'full_period', timing: 'now' } };
    expect(rules.fullPeriodUpgrade(full)).toBe(true);
    expect(rules.fullPeriodUpgrade(sw)).toBe(false);
    expect(rules.fullPeriodUpgrade({ ...full, kind: 'move' })).toBe(false);
    const renewed = paid({ currentPeriodEnd: at('2026-05-01T00:00:00Z') });
    expect(rules.chargeStillApplies({ subscription: renewed, sw: full, invoice }).applies).toBe(true);
    expect(rules.chargeStillApplies({ subscription: paid({ planId: PRO.id }), sw: full, invoice }).reason).toBe('plan_changed');
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

  it('a move to pay per order needs the prepaid balance still on', () => {
    const toFee = { ...sw, toPlanId: FEE.id };
    const subscription = paid({ planId: PRO.id });
    expect(rules.scheduleStillApplies({ subscription, sw: toFee, targetExists: true, toPayPerOrder: true, walletEnabled: true }).applies).toBe(true);
    expect(rules.scheduleStillApplies({ subscription, sw: toFee, targetExists: true, toPayPerOrder: true, walletEnabled: false })).toEqual({ applies: false, reason: 'wallet_disabled' });
    // Any other switch does not look at it.
    expect(rules.scheduleStillApplies({ subscription, sw, targetExists: true, walletEnabled: false }).applies).toBe(true);
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

describe('renewalAt', () => {
  const periodEnd = at('2026-04-01T00:00:00Z');
  const now = at('2026-03-17T12:00:00Z');

  it('has a date for a scheduled switch, a change at once, none and a trial', () => {
    expect(rules.renewalAt({ kind: 'scheduled', periodEnd, effectiveAt: at('2026-04-01T00:00:00Z'), now })).toEqual(at('2026-04-01T00:00:00Z'));
    expect(rules.renewalAt({ kind: 'immediate', periodEnd, now })).toEqual(periodEnd);
    expect(rules.renewalAt({ kind: 'none', periodEnd, now })).toEqual(periodEnd);
    expect(rules.renewalAt({ kind: 'trial_change', periodEnd, trialEndsAt: at('2026-03-20T00:00:00Z'), now })).toEqual(at('2026-03-20T00:00:00Z'));
    expect(rules.renewalAt({ kind: 'trial_change', periodEnd, now })).toEqual(periodEnd);
  });

  it('a period that has ended renews now', () => {
    const later = at('2026-04-05T00:00:00Z');
    expect(rules.renewalAt({ kind: 'immediate', periodEnd, now: later })).toEqual(later);
    expect(rules.renewalAt({ kind: 'none', periodEnd, now: later })).toEqual(later);
  });

  it('an upgrade now or a move has none yet: its period starts when it is paid', () => {
    expect(rules.renewalAt({ kind: 'upgrade', periodEnd, now })).toBeNull();
    expect(rules.renewalAt({ kind: 'move', periodEnd, now })).toBeNull();
    expect(rules.renewalAt({ kind: 'pay_per_order', periodEnd, now })).toBeNull();
  });
});

describe('proofUnderReview', () => {
  it('only a pending switch with a proof still waiting', () => {
    expect(rules.proofUnderReview({ status: 'pending', waitingProofs: 1 })).toBe(true);
    expect(rules.proofUnderReview({ status: 'pending', waitingProofs: 0 })).toBe(false);
    expect(rules.proofUnderReview({ status: 'scheduled', waitingProofs: 1 })).toBe(false);
    for (const status of ['applied', 'cancelled', 'replaced', 'expired', 'dropped']) {
      expect(rules.proofUnderReview({ status, waitingProofs: 2 })).toBe(false);
    }
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

describe('voiding a charge', () => {
  it('the merchant cancels a pending charge with no transfer under review, with the switch on', () => {
    expect(rules.cancellableByMerchant({ enabled: true, status: 'pending', waitingProofs: 0 })).toBe(true);
    expect(rules.cancellableByMerchant({ enabled: true, status: 'pending', waitingProofs: 1 })).toBe(false);
    expect(rules.cancellableByMerchant({ enabled: false, status: 'pending', waitingProofs: 0 })).toBe(false);
    for (const status of ['paid', 'void', 'failed']) expect(rules.cancellableByMerchant({ enabled: true, status, waitingProofs: 0 })).toBe(false);
  });

  it('a switch waiting for a voided charge ends with a word for each reason', () => {
    expect(rules.switchEndForVoid('cancelled')).toEqual({ status: 'cancelled', endReason: null });
    expect(rules.switchEndForVoid('replaced')).toEqual({ status: 'replaced', endReason: null });
    expect(rules.switchEndForVoid('expired')).toEqual({ status: 'expired', endReason: null });
    expect(rules.switchEndForVoid('cancelled_by_merchant')).toEqual({ status: 'cancelled', endReason: 'charge_cancelled' });
    expect(rules.switchEndForVoid('payment_failed')).toEqual({ status: 'cancelled', endReason: 'payment_failed' });
    expect(rules.switchEndForVoid('voided_by_admin')).toEqual({ status: 'dropped', endReason: 'admin_void' });
    expect(rules.switchEndForVoid('something else')).toBeNull();
    for (const reason of rules.VOID_REASONS) {
      expect(rules.switchEndForVoid(reason)).not.toBeNull();
      expect(reason.length).toBeLessThanOrEqual(40);
    }
  });
});
