'use strict';

const { planPrice } = require('./planPricing');

/**
 * The rules of a merchant switching plan by themselves
 * (billing/planSwitchService, PLAN_SWITCH_ENABLED). Nothing here reads or
 * writes the database: what kind of switch a request is, when it may take
 * effect, and whether a switch still fits the store when its moment comes
 * (its payment, or the end of the paid period).
 *
 *   - An upgrade inside a paid period offers two timings. "now": the new
 *     plan's full price for a full period that starts when it is paid (the
 *     days left of the old period are not carried over). "period_end": the
 *     store keeps its plan to the end of the paid period, then moves, and a
 *     renewal charge at the new plan's price is written then.
 *   - A downgrade takes effect when the paid period ends, with nothing given
 *     back; the store keeps its plan until then. So does a change of billing
 *     cycle alone, a plan priced in another currency, and a move to pay per
 *     order (no charge, no refund; the prepaid balance and its rules stay).
 *   - A period that has already ended: the plan changes at once and the
 *     renewal is the new plan's price.
 *   - From a free plan, the new plan is a full period from its payment.
 *
 * A price here is what the merchant pays for one period, after the store's
 * referral code — what the plans list shows them — on the cycle of the
 * period running now. Amounts are minor units.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// A period this many days long was one month or one year as paid. Any other
// length (a period set by hand in the console) is priced per nominal day.
const MONTH_DAYS = [28, 31];
const YEAR_DAYS = [365, 366];
const NOMINAL_DAYS = Object.freeze({ monthly: 30, yearly: 365 });
// A charge whose period starts this close to a schedule's moment is the one it prices.
const SCHEDULE_TOLERANCE_MS = 1000;

const KINDS = Object.freeze(['upgrade', 'move', 'scheduled', 'immediate']);
// When an upgrade takes effect: on its payment, or at the end of the paid period.
const TIMINGS = Object.freeze(['now', 'period_end']);
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
 * A `target` with a per-order fee is the pay-per-order plan.
 *
 * Resolves one of:
 *   { refuse: CODE }                     PLAN_CHANGE_NEEDS_SUPPORT (cancelled or
 *                                        suspended), MANUAL_PRICING (free or
 *                                        discounted by the console),
 *                                        SPECIAL_TERMS_ACTIVE
 *   { unavailable: true }                pay per order asked by a draft or a trial
 *                                        (they choose it from its card, as before)
 *                                        or by a store on another fee plan
 *   { kind: 'trial_change' }             a draft or a trial: changed at once
 *                                        (POST /billing/plan, as before)
 *   { kind: 'pay_per_order' }            the pay-per-order move (POST /billing/plan-move)
 *   { kind: 'none' }                     the same plan and cycle
 *   { kind: 'immediate', reason, free, payPerOrder }
 *                                        changed now, nothing to pay:
 *                                        period_ended | no_plan | free_plan |
 *                                        same_price | nothing_due | to_pay_per_order
 *   { kind: 'move', reason: 'from_free' } a full period of the new plan, from its payment
 *   { kind: 'scheduled', reason, effectiveAt, free, payPerOrder }
 *                                        at the end of the paid period:
 *                                        downgrade | cycle_change | currency |
 *                                        to_pay_per_order
 *   { kind: 'upgrade', reason: 'upgrade', timings, effectiveAt }
 *                                        a higher price: "now" (its full price,
 *                                        a full period from the payment) or
 *                                        "period_end" (at `effectiveAt`, then a
 *                                        renewal at its price); see resolveTiming
 * `free`: the new plan costs nothing, so it starts as an open-ended active period.
 * `payPerOrder`: the store moves to pay per order (walletService.startPayPerOrder).
 */
function decide({ subscription, current, target, targetCycle, specialTerms = false, now = new Date(), price = planPrice }) {
  const { mode, reason: refused } = selfServeMode({ subscription, current, specialTerms });
  const toPayPerOrder = Number(target.perOrderFeeAmount) > 0;
  if (mode === 'support') return { refuse: refused };
  if (toPayPerOrder && mode !== 'switch') return current && current.id === target.id ? { kind: 'none' } : { unavailable: true };
  if (mode === 'immediate') return { kind: 'trial_change' };
  if (mode === 'move') return { kind: 'pay_per_order' };

  // Pay per order has no billing cycle of its own: the store's stays.
  const cycle = toPayPerOrder ? subscription.billingCycle : targetCycle || subscription.billingCycle;
  const free = !toPayPerOrder && planPrice(target, cycle) === 0;
  if (current && current.id === target.id && cycle === subscription.billingCycle) return { kind: 'none' };

  const days = remainingDays(subscription.currentPeriodEnd, now);
  if (!current || days === 0) {
    const reason = toPayPerOrder ? 'to_pay_per_order' : current ? 'period_ended' : 'no_plan';
    return { kind: 'immediate', reason, free, payPerOrder: toPayPerOrder };
  }

  const terms = periodTerms({
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    billingCycle: subscription.billingCycle,
  });
  const currentFree = planPrice(current, terms.cycle) === 0;
  const effectiveAt = new Date(subscription.currentPeriodEnd);
  if (toPayPerOrder) {
    // Like a downgrade: at the end of the paid period, nothing paid, nothing given back.
    return currentFree
      ? { kind: 'immediate', reason: 'to_pay_per_order', free: false, payPerOrder: true }
      : { kind: 'scheduled', reason: 'to_pay_per_order', effectiveAt, free: false, payPerOrder: true };
  }
  if (currentFree) {
    return free ? { kind: 'immediate', reason: 'free_plan', free: true } : { kind: 'move', reason: 'from_free' };
  }

  if (current.currency !== target.currency) return { kind: 'scheduled', reason: 'currency', effectiveAt, free };
  if (current.id === target.id) return { kind: 'scheduled', reason: 'cycle_change', effectiveAt, free: false };

  const fromPrice = price(current, terms.cycle);
  const toPrice = price(target, terms.cycle);
  if (toPrice < fromPrice) return { kind: 'scheduled', reason: 'downgrade', effectiveAt, free };
  if (toPrice === fromPrice) return { kind: 'immediate', reason: 'same_price', free };
  // A code that makes the new plan cost nothing: there is nothing to pay for it.
  if (price(target, cycle) <= 0) return { kind: 'immediate', reason: 'nothing_due', free: false };
  return { kind: 'upgrade', reason: 'upgrade', timings: TIMINGS.slice(), effectiveAt };
}

/**
 * When a decided switch may take effect, and which `timing` the request
 * picks: an upgrade offers "now" (the default) and "period_end"; a scheduled
 * switch only "period_end"; anything else only "now". Resolves
 * { timing, kind, available } — `kind` being what the switch is with that
 * timing (an upgrade at the period's end is a scheduled one) — or
 * { error: 'SWITCH_TIMING_NOT_AVAILABLE', available } when the asked timing
 * isn't one of them.
 */
function resolveTiming(decision, requested) {
  const available = decision.timings ? decision.timings.slice() : [decision.kind === 'scheduled' ? 'period_end' : 'now'];
  if (requested && !available.includes(requested)) return { error: 'SWITCH_TIMING_NOT_AVAILABLE', available };
  const timing = requested || available[0];
  const kind = decision.kind === 'upgrade' && timing === 'period_end' ? 'scheduled' : decision.kind;
  return { timing, kind, available };
}

/** An upgrade switch priced at the new plan's full price for a full period (since timings), not the old prorated kind. */
function fullPeriodUpgrade(sw) {
  return Boolean(sw && sw.kind === 'upgrade' && sw.quote && sw.quote.pricing === 'full_period');
}

/**
 * Whether money paid for a switch's charge still does what it was for:
 * the store is still on the plan and cycle the switch was priced from, the
 * new plan still exists, and (an upgrade of the old, prorated kind) no later
 * period has been paid at the old price — a full-period upgrade starts its
 * own period from the payment, so that does not matter to it. A `late`
 * payment — the charge was void when it arrived — also needs the plan still
 * on offer and nothing else waiting (no other charge, no other switch).
 * Resolves { applies, reason }.
 */
function chargeStillApplies({ subscription, sw, invoice, late = false, targetOffered = true, otherPending = false, otherOpen = false }) {
  if (!sw.toPlanId) return { applies: false, reason: 'plan_gone' };
  if (CLOSED_SUBSCRIPTION.has(subscription.status)) return { applies: false, reason: 'subscription_closed' };
  if (subscription.pricingKind && subscription.pricingKind !== 'paid') return { applies: false, reason: 'manual_pricing' };
  if (subscription.planId !== sw.fromPlanId || subscription.billingCycle !== sw.fromBillingCycle) {
    return { applies: false, reason: 'plan_changed' };
  }
  const prorated = sw.kind === 'upgrade' && !fullPeriodUpgrade(sw);
  if (prorated && time(subscription.currentPeriodEnd) > time(invoice.periodEnd) + SCHEDULE_TOLERANCE_MS) {
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
 * When the next renewal falls after a switch of this `kind` (resolveTiming's,
 * so an upgrade at the period's end is 'scheduled'):
 *   scheduled               its moment (`effectiveAt`), when the new plan starts;
 *   immediate, none         the end of the period, or now once it has ended;
 *   trial_change            the trial's end (or the period's);
 *   upgrade, move,          null: its period starts when its charge is paid, so
 *   pay_per_order           the renewal (one period later) has no date yet.
 * A free plan, or pay per order, has no renewal at all; the caller leaves
 * `nextRenewal` out then.
 */
function renewalAt({ kind, periodEnd, effectiveAt = null, trialEndsAt = null, now }) {
  const end = new Date(periodEnd);
  switch (kind) {
    case 'scheduled':
      return new Date(effectiveAt);
    case 'immediate':
    case 'none':
      return end.getTime() > time(now) ? end : new Date(now);
    case 'trial_change':
      return new Date(trialEndsAt || periodEnd);
    default:
      return null;
  }
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
 * at `now`: { hours, expiresAt } for an upgrade "now" or a move (from a free
 * plan), after PLAN_SWITCH_CHARGE_EXPIRY_HOURS (`switchHours`); null for a
 * switch that writes no charge. A pay-per-order move's charge has its own
 * rule: WALLET_MOVE_EXPIRY_HOURS (`moveHours`), and only while
 * WALLET_ENABLED is on — off, it never expires by itself (null). `kind` is
 * resolveTiming's, so a pay-per-order move is 'pay_per_order'. The hourly
 * billing job voids the charge at its first run after `expiresAt`, unless a
 * transfer's proof for it is under review.
 */
function chargeExpiry({ kind, now, switchHours, moveHours, walletEnabled }) {
  const after = (hours) => ({ hours, expiresAt: expiresAt(now, hours) });
  if (kind === 'pay_per_order') return walletEnabled ? after(moveHours) : null;
  if (kind === 'upgrade' || kind === 'move') return after(switchHours);
  return null;
}

// ------------------------------------------------------- voiding a charge

// Why a pending charge was voided (billing_invoices.void_reason, migration 703).
const VOID_REASONS = Object.freeze(['cancelled', 'replaced', 'expired', 'cancelled_by_merchant', 'voided_by_admin', 'payment_failed']);

/**
 * Whether the merchant may cancel a charge (POST /billing/charges/:id/cancel):
 * PLAN_SWITCH_ENABLED on, the charge still pending (a paid one is never
 * touched), and no transfer's proof for it with the console.
 */
function cancellableByMerchant({ enabled, status, waitingProofs }) {
  return Boolean(enabled) && status === 'pending' && !(Number(waitingProofs) > 0);
}

/**
 * What a switch waiting for a charge becomes when that charge is voided for
 * `reason`: { status, endReason }, or null for a reason it doesn't know.
 */
function switchEndForVoid(reason) {
  switch (reason) {
    case 'cancelled':
    case 'replaced':
    case 'expired':
      return { status: reason, endReason: null };
    case 'cancelled_by_merchant':
      return { status: 'cancelled', endReason: 'charge_cancelled' };
    case 'payment_failed':
      return { status: 'cancelled', endReason: 'payment_failed' };
    case 'voided_by_admin':
      return { status: 'dropped', endReason: 'admin_void' };
    default:
      return null;
  }
}

module.exports = {
  DAY_MS,
  NOMINAL_DAYS,
  KINDS,
  TIMINGS,
  STATUSES,
  OPEN_STATUSES,
  VOID_REASONS,
  periodTerms,
  remainingDays,
  selfServeMode,
  decide,
  resolveTiming,
  fullPeriodUpgrade,
  chargeStillApplies,
  scheduleStillApplies,
  scheduleCovers,
  expiresAt,
  chargeExpiry,
  proofUnderReview,
  renewalAt,
  cancellableByMerchant,
  switchEndForVoid,
};
