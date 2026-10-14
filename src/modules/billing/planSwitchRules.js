'use strict';

const { planPrice } = require('./planPricing');

/**
 * The rules of a merchant switching plan by themselves
 * (billing/planSwitchService, PLAN_SWITCH_ENABLED). Nothing here reads or
 * writes the database: what kind of switch a request is, what an upgrade's
 * remaining days cost, and whether a switch still fits the store when its
 * moment comes (its payment, or the end of the paid period).
 *
 *   - An upgrade inside a paid period costs the difference for the days
 *     left; the new plan starts once that is paid, and the next renewal is
 *     the new plan's full price.
 *   - A downgrade takes effect when the paid period ends, with nothing given
 *     back; the store keeps its plan until then. So does a change of billing
 *     cycle alone, and a plan priced in another currency (no difference can
 *     be worked out across two currencies).
 *   - A period that has already ended has nothing left to share out: the
 *     plan changes at once and the renewal is the new plan's price.
 *   - From a free plan, the new plan is a full period from its payment.
 *
 * A price here is what the merchant pays for one period, after the store's
 * referral code — what the plans list shows them — on the cycle of the
 * period running now. Amounts are minor units.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// An upgrade's amount is whole currency units: a transfer has to match it exactly.
const MINOR_PER_UNIT = 100;
// A period this many days long was one month or one year as paid. Any other
// length (a period set by hand in the console) is priced per nominal day.
const MONTH_DAYS = [28, 31];
const YEAR_DAYS = [365, 366];
const NOMINAL_DAYS = Object.freeze({ monthly: 30, yearly: 365 });
// A charge whose period starts this close to a schedule's moment is the one it prices.
const SCHEDULE_TOLERANCE_MS = 1000;

const KINDS = Object.freeze(['upgrade', 'move', 'scheduled', 'immediate']);
const STATUSES = Object.freeze(['pending', 'scheduled', 'applied', 'cancelled', 'replaced', 'expired', 'dropped']);
// At most one of these per subscription (a unique partial index).
const OPEN_STATUSES = Object.freeze(['pending', 'scheduled']);
const CLOSED_SUBSCRIPTION = new Set(['cancelled', 'suspended']);

const time = (value) => new Date(value).getTime();

/**
 * The cycle the running period was paid on, and the days one such cycle has:
 * the period's own length when it is one month (28–31 days) or one year
 * (365–366), else the stored cycle at 30 or 365 nominal days.
 */
function periodTerms({ periodStart, periodEnd, billingCycle }) {
  const days = Math.round((time(periodEnd) - time(periodStart)) / DAY_MS);
  if (days >= MONTH_DAYS[0] && days <= MONTH_DAYS[1]) return { cycle: 'monthly', cycleDays: days, standard: true };
  if (days >= YEAR_DAYS[0] && days <= YEAR_DAYS[1]) return { cycle: 'yearly', cycleDays: days, standard: true };
  const cycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
  return { cycle, cycleDays: NOMINAL_DAYS[cycle], standard: false };
}

/** Whole days left until `periodEnd`, today counted: the new plan is had from today. 0 once it has passed. */
function remainingDays(periodEnd, now) {
  const left = time(periodEnd) - time(now);
  return left > 0 ? Math.ceil(left / DAY_MS) : 0;
}

/**
 * What an upgrade costs: (toPrice − fromPrice) × days ÷ cycleDays, rounded
 * half up to whole currency units. Nothing when the new price is not higher
 * or no day is left. Integer arithmetic only.
 */
function prorate({ fromPrice, toPrice, days, cycleDays }) {
  for (const [name, value] of Object.entries({ fromPrice, toPrice, days, cycleDays })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  }
  if (cycleDays === 0) throw new TypeError('cycleDays must be above zero');
  const difference = toPrice - fromPrice;
  if (difference <= 0 || days === 0) return { difference, amount: 0 };
  const numerator = difference * days;
  const denominator = cycleDays * MINOR_PER_UNIT;
  if (!Number.isSafeInteger(2 * numerator + denominator)) throw new RangeError('The amount is out of range');
  const units = Math.floor((2 * numerator + denominator) / (2 * denominator));
  return { difference, amount: units * MINOR_PER_UNIT };
}

/**
 * How this subscription changes plan, whatever the plan asked for:
 *   immediate  a draft or a trial: at once, nothing paid (POST /billing/plan)
 *   move       pay per order: the move (POST /billing/plan-move)
 *   switch     a paid subscription: by itself (POST /billing/plan-switch)
 *   support    through Zimos support; `reason` says why:
 *              PLAN_CHANGE_NEEDS_SUPPORT (cancelled or suspended),
 *              MANUAL_PRICING (free or discounted by the console),
 *              SPECIAL_TERMS_ACTIVE (a special-terms grant is running)
 */
function selfServeMode({ subscription, current, specialTerms = false }) {
  const { status } = subscription;
  if (status === 'draft' || status === 'trialing') return { mode: 'immediate', reason: null };
  if (CLOSED_SUBSCRIPTION.has(status)) return { mode: 'support', reason: 'PLAN_CHANGE_NEEDS_SUPPORT' };
  if (current && Number(current.perOrderFeeAmount) > 0) return { mode: 'move', reason: null };
  if (subscription.pricingKind && subscription.pricingKind !== 'paid') return { mode: 'support', reason: 'MANUAL_PRICING' };
  if (specialTerms) return { mode: 'support', reason: 'SPECIAL_TERMS_ACTIVE' };
  return { mode: 'switch', reason: null };
}

/**
 * What a request to move to `target` on `targetCycle` is, for a store whose
 * subscription and plan (`current`) are as given. `price(plan, cycle)` is the
 * merchant's price for one period (the plan's price less the referral code);
 * it defaults to the plan's own price. `specialTerms`: a special-terms grant
 * is running (a price override with charges left, or free months not over).
 *
 * Resolves one of:
 *   { refuse: CODE }                     PLAN_CHANGE_NEEDS_SUPPORT (cancelled or
 *                                        suspended), MANUAL_PRICING (free or
 *                                        discounted by the console),
 *                                        SPECIAL_TERMS_ACTIVE
 *   { kind: 'trial_change' }             a draft or a trial: changed at once
 *                                        (POST /billing/plan, as before)
 *   { kind: 'pay_per_order' }            the pay-per-order move (POST /billing/plan-move)
 *   { kind: 'none' }                     the same plan and cycle
 *   { kind: 'immediate', reason, free }  changed now, nothing to pay:
 *                                        period_ended | no_plan | free_plan |
 *                                        same_price | nothing_due
 *   { kind: 'move', reason: 'from_free' } a full period of the new plan, from its payment
 *   { kind: 'scheduled', reason, effectiveAt, free }
 *                                        at the end of the paid period:
 *                                        downgrade | cycle_change | currency
 *   { kind: 'upgrade', proration }       the difference for the days left, then
 *                                        the new plan at once
 * `free`: the new plan costs nothing, so it starts as an open-ended active period.
 */
function decide({ subscription, current, target, targetCycle, specialTerms = false, now = new Date(), price = planPrice }) {
  const { mode, reason: refused } = selfServeMode({ subscription, current, specialTerms });
  if (mode === 'immediate') return { kind: 'trial_change' };
  if (mode === 'support') return { refuse: refused };
  if (mode === 'move') return { kind: 'pay_per_order' };

  const cycle = targetCycle || subscription.billingCycle;
  const free = planPrice(target, cycle) === 0;
  if (current && current.id === target.id && cycle === subscription.billingCycle) return { kind: 'none' };

  const days = remainingDays(subscription.currentPeriodEnd, now);
  if (!current) return { kind: 'immediate', reason: 'no_plan', free };
  if (days === 0) return { kind: 'immediate', reason: 'period_ended', free };

  const terms = periodTerms({
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    billingCycle: subscription.billingCycle,
  });
  if (planPrice(current, terms.cycle) === 0) {
    return free ? { kind: 'immediate', reason: 'free_plan', free: true } : { kind: 'move', reason: 'from_free' };
  }

  const effectiveAt = new Date(subscription.currentPeriodEnd);
  if (current.currency !== target.currency) return { kind: 'scheduled', reason: 'currency', effectiveAt, free };
  if (current.id === target.id) return { kind: 'scheduled', reason: 'cycle_change', effectiveAt, free: false };

  const fromPrice = price(current, terms.cycle);
  const toPrice = price(target, terms.cycle);
  if (toPrice < fromPrice) return { kind: 'scheduled', reason: 'downgrade', effectiveAt, free };
  if (toPrice === fromPrice) return { kind: 'immediate', reason: 'same_price', free };

  const { difference, amount } = prorate({ fromPrice, toPrice, days, cycleDays: terms.cycleDays });
  const proration = {
    remainingDays: days,
    cycleDays: terms.cycleDays,
    periodCycle: terms.cycle,
    standardPeriod: terms.standard,
    fromPrice,
    toPrice,
    difference,
    amount,
    currency: target.currency,
  };
  if (amount === 0) return { kind: 'immediate', reason: 'nothing_due', free: false, proration };
  return { kind: 'upgrade', proration };
}

/**
 * Whether money paid for a switch's charge still does what it was for:
 * the store is still on the plan and cycle the switch was priced from, the
 * new plan still exists, and (an upgrade) no later period has been paid at
 * the old price. A `late` payment — the charge was void when it arrived —
 * also needs the plan still on offer and nothing else waiting (no other
 * charge, no other switch). Resolves { applies, reason }.
 */
function chargeStillApplies({ subscription, sw, invoice, late = false, targetOffered = true, otherPending = false, otherOpen = false }) {
  if (!sw.toPlanId) return { applies: false, reason: 'plan_gone' };
  if (CLOSED_SUBSCRIPTION.has(subscription.status)) return { applies: false, reason: 'subscription_closed' };
  if (subscription.pricingKind && subscription.pricingKind !== 'paid') return { applies: false, reason: 'manual_pricing' };
  if (subscription.planId !== sw.fromPlanId || subscription.billingCycle !== sw.fromBillingCycle) {
    return { applies: false, reason: 'plan_changed' };
  }
  if (sw.kind === 'upgrade' && time(subscription.currentPeriodEnd) > time(invoice.periodEnd) + SCHEDULE_TOLERANCE_MS) {
    return { applies: false, reason: 'period_renewed' };
  }
  if (late) {
    if (!targetOffered) return { applies: false, reason: 'plan_not_offered' };
    if (otherPending) return { applies: false, reason: 'other_charge_pending' };
    if (otherOpen) return { applies: false, reason: 'other_switch_open' };
  }
  return { applies: true, reason: null };
}

/**
 * Whether a scheduled switch is still the store's when its moment comes: on
 * the plan and cycle it was asked from, the new plan still there, the
 * subscription neither closed nor priced by hand. Resolves { applies, reason }.
 */
function scheduleStillApplies({ subscription, sw, targetExists }) {
  if (!sw.toPlanId || !targetExists) return { applies: false, reason: 'plan_gone' };
  if (CLOSED_SUBSCRIPTION.has(subscription.status)) return { applies: false, reason: 'subscription_closed' };
  if (subscription.pricingKind && subscription.pricingKind !== 'paid') return { applies: false, reason: 'manual_pricing' };
  if (subscription.planId !== sw.fromPlanId || subscription.billingCycle !== sw.fromBillingCycle) {
    return { applies: false, reason: 'plan_changed' };
  }
  return { applies: true, reason: null };
}

/** Whether a charge for a period starting at `periodStart` is priced by a schedule taking effect at `effectiveAt`. */
function scheduleCovers(effectiveAt, periodStart) {
  return time(periodStart) >= time(effectiveAt) - SCHEDULE_TOLERANCE_MS;
}

/** When an unpaid switch's charge is voided. */
function expiresAt(createdAt, hours) {
  return new Date(time(createdAt) + hours * 60 * 60 * 1000);
}

/**
 * Whether a transfer's proof for the charge a switch waits on is under
 * review: only a pending switch (a scheduled one has no charge), with at
 * least one proof still waiting for the console. While true, cancelling or
 * replacing the switch is refused (409 PROOF_UNDER_REVIEW) and it does not
 * expire.
 */
function proofUnderReview({ status, waitingProofs }) {
  return status === 'pending' && Number(waitingProofs) > 0;
}

/**
 * How long the charge a switch would write lives unpaid if it were started
 * at `now`: { hours, expiresAt } for an upgrade or a move (from a free plan),
 * after PLAN_SWITCH_CHARGE_EXPIRY_HOURS (`switchHours`); null for a switch
 * that writes no charge. A pay-per-order move's charge has its own rule:
 * WALLET_MOVE_EXPIRY_HOURS (`moveHours`), and only while WALLET_ENABLED is
 * on — off, it never expires by itself (null). `kind` is decide()'s, so a
 * pay-per-order move is 'pay_per_order'. The hourly billing job voids the
 * charge at its first run after `expiresAt`, unless a transfer's proof for
 * it is under review.
 */
function chargeExpiry({ kind, now, switchHours, moveHours, walletEnabled }) {
  const after = (hours) => ({ hours, expiresAt: expiresAt(now, hours) });
  if (kind === 'pay_per_order') return walletEnabled ? after(moveHours) : null;
  if (kind === 'upgrade' || kind === 'move') return after(switchHours);
  return null;
}

module.exports = {
  DAY_MS,
  MINOR_PER_UNIT,
  NOMINAL_DAYS,
  KINDS,
  STATUSES,
  OPEN_STATUSES,
  periodTerms,
  remainingDays,
  prorate,
  selfServeMode,
  decide,
  chargeStillApplies,
  scheduleStillApplies,
  scheduleCovers,
  expiresAt,
  chargeExpiry,
  proofUnderReview,
};
