'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const referralCodes = require('../referrals/referralCodeService');
const charges = require('./subscriptionChargeService');
const publicPlans = require('./publicPlansService');
const paymentMethods = require('./paymentMethodService');
const specialTerms = require('./specialTermsService');
const settlement = require('./planSwitchSettlement');
const rules = require('./planSwitchRules');
const { planPrice } = require('./planPricing');
const { FREE_PLAN_YEARS } = require('./goLiveService');

// merchantPlansService lists the plans with this file's summary in them.
// eslint-disable-next-line global-require
const merchantPlans = () => require('./merchantPlansService');

/**
 * A merchant changing plan by themselves, at any time, from the Plans tab
 * (billing.manage), behind PLAN_SWITCH_ENABLED (off: as before, a paid
 * subscription changes plan through support). The rules are
 * billing/planSwitchRules; what money paid for a switch does is
 * billing/planSwitchSettlement.
 *
 *   POST /billing/plan-switch/preview { planId, billingCycle? }
 *        what the switch would be, writing nothing: its kind, when it takes
 *        effect, what is due now (an upgrade: the difference for the days
 *        left) and what the next renewal costs.
 *   POST /billing/plan-switch { planId, billingCycle?, expectedAmount? }
 *        upgrade    one pending charge for the difference; the plan changes
 *                   when it is paid (online, a transfer's proof approved, the
 *                   console), the paid period kept;
 *        move       from a free plan: one charge for a full period of the new
 *                   plan, which starts when it is paid;
 *        scheduled  a downgrade, a cycle change, another currency: nothing
 *                   paid, nothing given back; the store keeps its plan until
 *                   the paid period ends, then the hourly billing job changes
 *                   it, and the renewal is priced on the new plan;
 *        immediate  the period has ended, or there is nothing to pay: changed
 *                   now.
 *        A draft or a trial changes plan at once and a pay-per-order store
 *        moves, through their own paths, as before.
 *   POST /billing/plan-switch/cancel
 *        the switch waiting is dropped: its charge void (not owed), the store
 *        exactly as it is. Works with the flag off too (it only undoes).
 *
 * One switch waits at a time. A new request replaces the one waiting (and a
 * renewal charge priced for the plan being left), except while a transfer's
 * proof for that charge is with the console (409 PROOF_UNDER_REVIEW). The
 * same request again gets the same charge back. A downgrade whose next
 * period is already paid at its price stays (409 PLAN_SWITCH_ALREADY_BILLED):
 * the merchant changes plan again once it has taken effect. A pending charge is locked
 * before the subscription, the order every payment takes; a charge that
 * appears between the two is 409 PLAN_SWITCH_BUSY (asked twice at once:
 * ask again). An upgrade's charge left unpaid PLAN_SWITCH_CHARGE_EXPIRY_HOURS
 * is voided by the hourly billing job.
 */

const OPEN = rules.OPEN_STATUSES;

function enabled() {
  return env.billing.planSwitch.enabled === true;
}

function disabledError() {
  return new AppError('PLAN_SWITCH_DISABLED', 'Changing plan by yourself is not available.', 404);
}

const REFUSALS = {
  PLAN_CHANGE_NEEDS_SUPPORT: 'This subscription is closed, so its plan is changed through Zimos support. Contact support.',
  MANUAL_PRICING: "Your plan's price was set by Zimos, so your plan is changed through Zimos support. Contact support.",
  SPECIAL_TERMS_ACTIVE: 'Your plan has special terms agreed with Zimos, so it is changed through Zimos support. Contact support.',
};
const refusal = (code) => new ConflictError(REFUSALS[code], code);
const busy = () => new ConflictError('Another plan change was just made for this store. Refresh and try again.', 'PLAN_SWITCH_BUSY');
const proofUnderReview = (invoiceId) =>
  new AppError('PROOF_UNDER_REVIEW', 'A transfer for the charge waiting is being checked. Wait for the review before changing plan again.', 409, { invoiceId });
const noPaymentMethod = (currency) =>
  new AppError('NO_PAYMENT_METHOD', `There is no way to pay a charge in ${currency} online or by transfer right now. Contact support.`, 409, { currency });
const amountChanged = (amountDue, currency) =>
  new AppError('SWITCH_AMOUNT_CHANGED', 'The amount due has changed since it was shown. Check the new amount before going on.', 409, { amountDue, currency });
const alreadyBilled = (invoiceId, effectiveAt) =>
  new AppError(
    'PLAN_SWITCH_ALREADY_BILLED',
    'The period after this change is already paid at the new plan’s price, so the change stays. Choose another plan once it has taken effect.',
    409,
    { invoiceId, effectiveAt }
  );

/** A renewal already paid at a scheduled switch's price (its period starts at the switch's moment), or null. */
async function billedOnSchedule(sw, transaction) {
  if (!sw || sw.status !== 'scheduled') return null;
  const renewals = await db.BillingInvoice.findAll({
    where: { subscriptionId: sw.subscriptionId, status: 'paid', targetPlanId: null },
    attributes: ['id', 'periodStart'],
    transaction,
  });
  return renewals.find((invoice) => rules.scheduleCovers(sw.effectiveAt, invoice.periodStart)) || null;
}

async function loadSubscription(workspaceId, transaction, { lock = false } = {}) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!subscription) throw new NotFoundError('Subscription');
  return subscription;
}

/** The plan a switch goes to: one on offer (422 PLAN_NOT_AVAILABLE otherwise). */
async function findSwitchTarget(planId, transaction) {
  return publicPlans.findOfferedPlan(planId, transaction);
}

const proofWaiting = async (invoiceId, transaction) =>
  (await db.PaymentProof.count({ where: { billingInvoiceId: invoiceId, status: 'pending' }, transaction })) > 0;

/** Whether a special-terms grant is running: a price override with charges left, or free months not over. */
async function specialTermsRunning(subscription, transaction, now) {
  const [override, compEnd] = await Promise.all([
    specialTerms.activePriceOverride(subscription.id, { transaction }),
    specialTerms.compCoveredUntil(subscription.id, transaction),
  ]);
  return Boolean(override) || Boolean(compEnd && compEnd.getTime() > now.getTime());
}

/**
 * The store's plan, the merchant's price function (the plan's price less the
 * referral code usable now, as the plans list shows it) and the decision for
 * `target` on `cycle`.
 */
async function decisionFor(subscription, target, cycle, transaction, now) {
  const [current, code, terms] = await Promise.all([
    subscription.planId ? db.Plan.findByPk(subscription.planId, { transaction }) : null,
    subscription.referralCodeId ? db.ReferralCode.findByPk(subscription.referralCodeId, { transaction }) : null,
    specialTermsRunning(subscription, transaction, now),
  ]);
  const usable = code && code.active ? code : null;
  const price = (plan, billingCycle) => {
    const gross = planPrice(plan, billingCycle);
    return gross - referralCodes.discountFor(usable, gross, plan.currency);
  };
  const decision = rules.decide({ subscription, current, target, targetCycle: cycle, specialTerms: terms, now, price });
  return { current, price, decision };
}

/** A full period of `plan` on `cycle`, priced as any charge (the code, a special-terms price): a move's charge. */
async function fullPeriodPrice(subscription, plan, cycle, transaction) {
  const { amount } = await charges.priceCharge({ id: subscription.id, billingCycle: cycle, referralCodeId: subscription.referralCodeId }, plan, transaction);
  return amount;
}

/**
 * What is due now for a switch of `kind` (resolveTiming's): an upgrade "now"
 * or a move is the new plan's full price for a full period; anything else
 * (an upgrade at the period's end included) nothing now. Minor units.
 */
async function amountDueFor(kind, subscription, target, cycle, transaction) {
  if (kind === 'upgrade' || kind === 'move' || kind === 'pay_per_order') return fullPeriodPrice(subscription, target, cycle, transaction);
  return 0;
}

const timingNotAvailable = (timing, available) =>
  new AppError('SWITCH_TIMING_NOT_AVAILABLE', `This change can't take effect "${timing}". It can: ${available.join(', ')}.`, 409, { timing, available });

// --------------------------------------------------------------- serialize

async function withPlans(sw, transaction) {
  const [fromPlan, toPlan, invoice, waitingProofs] = await Promise.all([
    sw.fromPlanId ? db.Plan.findByPk(sw.fromPlanId, { attributes: ['id', 'name'], transaction }) : null,
    sw.toPlanId ? db.Plan.findByPk(sw.toPlanId, { attributes: ['id', 'name'], transaction }) : null,
    sw.billingInvoiceId ? db.BillingInvoice.findByPk(sw.billingInvoiceId, { transaction }) : null,
    sw.status === 'pending' && sw.billingInvoiceId
      ? db.PaymentProof.count({ where: { billingInvoiceId: sw.billingInvoiceId, status: 'pending' }, transaction })
      : 0,
  ]);
  return serialize(sw, { fromPlan, toPlan, invoice, proofUnderReview: rules.proofUnderReview({ status: sw.status, waitingProofs }) });
}

/** What the merchant sees of a switch. */
function serialize(sw, { fromPlan = null, toPlan = null, invoice = null, proofUnderReview = false } = {}) {
  const quote = sw.quote || null;
  return {
    id: sw.id,
    kind: sw.kind,
    status: sw.status,
    from: { planId: sw.fromPlanId, planName: fromPlan ? fromPlan.name : null, billingCycle: sw.fromBillingCycle },
    to: { planId: sw.toPlanId, planName: toPlan ? toPlan.name : null, billingCycle: sw.toBillingCycle },
    // Why a scheduled or immediate switch is one (downgrade, cycle_change,
    // currency, upgrade, to_pay_per_order, period_ended, …), else null.
    reason: quote && quote.reason ? quote.reason : null,
    // An upgrade: "now" (paid now, a full period from the payment) or
    // "period_end" (scheduled); null for any other switch and older rows.
    timing: quote && quote.timing ? quote.timing : null,
    // A scheduled switch: when it takes effect.
    effectiveAt: sw.effectiveAt || null,
    appliedAt: sw.appliedAt || null,
    endedAt: sw.endedAt || null,
    endReason: sw.endReason || null,
    // An upgrade or a move: the charge to pay (POST /billing/payments, or a
    // transfer's proof to /billing/invoices/:invoiceId/payment-proofs).
    invoiceId: sw.billingInvoiceId || null,
    amountDue: invoice ? Number(invoice.amount) : quote && quote.amount != null ? Number(quote.amount) : null,
    currency: invoice ? invoice.currency : quote ? quote.currency || null : null,
    // When its charge is voided if still unpaid.
    expiresAt: sw.status === 'pending' ? rules.expiresAt(sw.createdAt, env.billing.planSwitch.chargeExpiryHours) : null,
    // A transfer's proof for its charge is with the console: cancelling or
    // replacing it is refused (409 PROOF_UNDER_REVIEW) until it is reviewed.
    proofUnderReview: Boolean(proofUnderReview),
    // Only an upgrade of the old, prorated kind had one; a full-period upgrade has none.
    proration:
      sw.kind === 'upgrade' && quote && !rules.fullPeriodUpgrade(sw)
        ? {
            remainingDays: quote.remainingDays,
            cycleDays: quote.cycleDays,
            fromPrice: quote.fromPrice,
            toPrice: quote.toPrice,
            amount: quote.amount,
            currency: quote.currency,
          }
        : null,
    createdAt: sw.createdAt,
  };
}

const EFFECTIVE = { upgrade: 'on_payment', move: 'on_payment', pay_per_order: 'on_payment', scheduled: 'period_end', immediate: 'now', trial_change: 'now', none: null };

/**
 * One timing of a switch, as the preview shows it: when it takes effect,
 * what is due now, how long that charge would live, the next renewal, and
 * what would stop starting it.
 */
async function optionFor(timing, { subscription, target, cycle, decision, price, now, open, proof, billed }) {
  const { kind } = rules.resolveTiming(decision, timing);
  const amountDue = await amountDueFor(kind, subscription, target, cycle);
  const charged = amountDue > 0;
  // A free plan, or pay per order, has no renewal to price.
  const noRenewal = planPrice(target, cycle) === 0;
  const effectiveAt = kind === 'scheduled' ? decision.effectiveAt : kind === 'immediate' || kind === 'trial_change' ? now : null;
  const renewalAt = rules.renewalAt({ kind, periodEnd: subscription.currentPeriodEnd, effectiveAt, trialEndsAt: subscription.trialEndsAt, now });

  const sameScheduled = Boolean(open && open.status === 'scheduled' && kind === 'scheduled' && open.toPlanId === target.id && open.toBillingCycle === cycle);
  let blockedBy = null;
  if (kind !== 'none' && kind !== 'trial_change' && proof) blockedBy = 'PROOF_UNDER_REVIEW';
  else if (billed && !sameScheduled && kind !== 'trial_change') blockedBy = 'PLAN_SWITCH_ALREADY_BILLED';
  else if (charged && !(await paymentMethods.anyOffered(target.currency))) blockedBy = 'NO_PAYMENT_METHOD';

  return {
    effective: EFFECTIVE[kind],
    effectiveAt,
    amountDue,
    currency: target.currency,
    // How long the charge it writes would live unpaid if started now; null when it writes none.
    chargeExpiry: rules.chargeExpiry({
      kind,
      now,
      switchHours: env.billing.planSwitch.chargeExpiryHours,
      moveHours: env.wallet.moveExpiryHours,
      walletEnabled: env.wallet.enabled === true,
    }),
    // null for a free plan or pay per order; `at` null when the new period starts on payment.
    nextRenewal: noRenewal ? null : { at: renewalAt, amount: price(target, cycle), currency: target.currency, billingCycle: cycle },
    // Pay per order is never paid for; otherwise whether the store can pay `currency` itself.
    payable: decision.payPerOrder ? false : charged ? blockedBy !== 'NO_PAYMENT_METHOD' : null,
    blockedBy,
  };
}

/**
 * The preview's body for a decision and the `timing` asked (resolved). Its
 * top-level when/what fields are those of that timing; `options` has one
 * entry per timing the switch offers (an upgrade: "now" and "period_end").
 */
async function describe({ subscription, current, target, cycle, decision, resolved, price, now, pending, open, proof, billed = null }) {
  const context = { subscription, target, cycle, decision, price, now, open, proof, billed };
  const options = {};
  for (const timing of resolved.available) options[timing] = await optionFor(timing, context);
  const chosen = options[resolved.timing];
  const days = rules.remainingDays(subscription.currentPeriodEnd, now);
  const termsCycle = rules.periodTerms({ periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd, billingCycle: subscription.billingCycle }).cycle;
  // The paid period running now, for "N days left (ends on …)"; none for a free plan or pay per order.
  const currentPeriod = current && days > 0 && planPrice(current, termsCycle) > 0 ? { endsAt: new Date(subscription.currentPeriodEnd), remainingDays: days } : null;

  return {
    kind: decision.kind === 'pay_per_order' ? 'move' : decision.kind,
    reason: decision.reason || (decision.kind === 'pay_per_order' ? 'pay_per_order' : null),
    // The timing described below, the ones on offer, and each one's terms.
    timing: resolved.timing,
    timings: resolved.available,
    options,
    effective: chosen.effective,
    effectiveAt: chosen.effectiveAt,
    from: current ? { planId: current.id, planName: current.name, billingCycle: subscription.billingCycle, currency: current.currency } : null,
    to: { planId: target.id, planName: target.name, billingCycle: cycle, currency: target.currency },
    currentPeriod,
    amountDue: chosen.amountDue,
    currency: target.currency,
    // An upgrade is no longer priced for the days left: always null now.
    proration: null,
    // Never a free trial on a switch.
    trial: false,
    chargeExpiry: chosen.chargeExpiry,
    nextRenewal: chosen.nextRenewal,
    payable: chosen.payable,
    blockedBy: chosen.blockedBy,
    // What starting it would replace or cancel: the switch waiting, or a charge priced for the plan being left.
    replaces: open
      ? { switchId: open.id, kind: open.kind, status: open.status, toPlanId: open.toPlanId, toBillingCycle: open.toBillingCycle, invoiceId: open.billingInvoiceId || null }
      : pending && !pending.targetPlanId && decision.kind !== 'none' && decision.kind !== 'trial_change'
        ? { switchId: null, kind: 'renewal', status: 'pending', toPlanId: null, toBillingCycle: null, invoiceId: pending.id }
        : null,
  };
}

/** The decision, with what it refuses thrown: support's codes (409) and a plan not on offer (422). */
function assertDecided(decision) {
  if (decision.refuse) throw refusal(decision.refuse);
  if (decision.unavailable) {
    throw new AppError('PLAN_NOT_AVAILABLE', 'This plan is not available', 422, [{ field: 'planId', message: 'Choose one of the plans on offer' }]);
  }
}

/** The timing asked, resolved against what the switch offers (409 SWITCH_TIMING_NOT_AVAILABLE otherwise). */
function timingOf(decision, timing) {
  const resolved = rules.resolveTiming(decision, timing);
  if (resolved.error) throw timingNotAvailable(timing, resolved.available);
  return resolved;
}

// ---------------------------------------------------------------- preview

/** POST /workspaces/:id/billing/plan-switch/preview — writes nothing. */
async function preview(workspaceId, { planId, billingCycle, timing } = {}) {
  if (!enabled()) throw disabledError();
  const target = await findSwitchTarget(planId);
  const subscription = await loadSubscription(workspaceId);
  const now = new Date();
  const cycle = billingCycle || subscription.billingCycle;
  const { current, price, decision } = await decisionFor(subscription, target, cycle, null, now);
  assertDecided(decision);
  const resolved = timingOf(decision, timing);
  const [pending, open] = await Promise.all([
    db.BillingInvoice.findOne({ where: { subscriptionId: subscription.id, status: 'pending' } }),
    db.PlanSwitch.findOne({ where: { subscriptionId: subscription.id, status: OPEN } }),
  ]);
  const proof = pending ? await proofWaiting(pending.id) : false;
  const billed = await billedOnSchedule(open);
  return { preview: await describe({ subscription, current, target, cycle, decision, resolved, price, now, pending, open, proof, billed }) };
}

// ------------------------------------------------------------------ start

/** The store moves to `plan` on `cycle` now (`free`: an open-ended active period, as a free plan is activated). */
async function applyTo(subscription, plan, cycle, { free }, transaction, now = new Date()) {
  const patch = { planId: plan.id, billingCycle: cycle };
  if (free) {
    const end = new Date(now);
    end.setUTCFullYear(end.getUTCFullYear() + FREE_PLAN_YEARS);
    Object.assign(patch, { status: 'active', trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: end, graceUntil: null, cancelAtPeriodEnd: false });
  }
  await subscription.update(patch, { transaction });
}

/**
 * Closes the switch waiting (and voids its charge) as `status`: cancelled by
 * the merchant, or replaced by a new one. A scheduled one whose next period
 * is already paid at its price stays (409 PLAN_SWITCH_ALREADY_BILLED); a
 * renewal still waiting that it priced goes with it.
 */
async function closeOpen(open, locked, status, req, transaction) {
  if (open.status === 'scheduled') {
    const billed = await billedOnSchedule(open, transaction);
    if (billed) throw alreadyBilled(billed.id, open.effectiveAt);
    if (locked && locked.status === 'pending' && !locked.targetPlanId && rules.scheduleCovers(open.effectiveAt, locked.periodStart)) {
      if (await proofWaiting(locked.id, transaction)) throw proofUnderReview(locked.id);
      await charges.voidRenewalCharge(locked, { actorUserId: req.user.id, req }, transaction);
    }
  }
  if (open.status === 'pending' && open.billingInvoiceId) {
    const invoice = await db.BillingInvoice.findByPk(open.billingInvoiceId, { transaction });
    if (invoice && invoice.status === 'pending') {
      if (!locked || locked.id !== invoice.id) throw busy();
      if (await proofWaiting(invoice.id, transaction)) throw proofUnderReview(invoice.id);
      await charges.voidMoveCharge(invoice, status, { actorUserId: req.user.id, req }, transaction);
    }
  }
  // Whatever is still open (a scheduled switch, or a pending one whose charge was already gone).
  await db.PlanSwitch.update({ status, endedAt: new Date() }, { where: { id: open.id, status: OPEN }, transaction });
  await open.reload({ transaction });
}

/**
 * POST /workspaces/:id/billing/plan-switch { planId, billingCycle?, timing?,
 * expectedAmount? } — 201 with a new switch, 200 when the same one is handed
 * back or nothing changes. `timing` picks when an upgrade takes effect
 * ("now", the default, or "period_end"); any other switch has one timing
 * (409 SWITCH_TIMING_NOT_AVAILABLE for another).
 */
async function start(workspaceId, { planId, billingCycle, timing, expectedAmount } = {}, req) {
  if (!enabled()) throw disabledError();
  const target = await findSwitchTarget(planId);
  const peek = await loadSubscription(workspaceId);
  const cycle = billingCycle || peek.billingCycle;
  const peekPlan = peek.planId ? await db.Plan.findByPk(peek.planId) : null;
  const { mode } = rules.selfServeMode({ subscription: peek, current: peekPlan });

  // A draft or a trial changes plan at once, as before; pay per order moves, as before.
  if ((mode === 'immediate' || mode === 'move') && timing && timing !== 'now') throw timingNotAvailable(timing, ['now']);
  if (mode === 'immediate') {
    const result = await merchantPlans().changePlan(workspaceId, { planId, billingCycle }, req);
    return { kind: 'trial_change', created: false, changed: result.changed, switch: null, invoice: null, plans: result.plans };
  }
  if (mode === 'move') {
    if (expectedAmount != null) {
      const due = await fullPeriodPrice(peek, target, cycle);
      if (due !== expectedAmount) throw amountChanged(due, target.currency);
    }
    const result = await merchantPlans().requestPlanMove(workspaceId, { planId, billingCycle: cycle }, req);
    return { kind: 'move', created: result.created, changed: false, switch: null, invoice: result.invoice, plans: result.plans };
  }

  const outcome = await db.sequelize.transaction(async (transaction) => {
    // A pending charge is locked before the subscription, the order a payment takes.
    const locked = await merchantPlans().lockPendingCharge(workspaceId, transaction);
    const subscription = await loadSubscription(workspaceId, transaction, { lock: true });
    const now = new Date();
    const { current, decision } = await decisionFor(subscription, target, cycle, transaction, now);
    assertDecided(decision);
    if (decision.kind === 'trial_change' || decision.kind === 'pay_per_order') throw busy();
    const resolved = timingOf(decision, timing);
    // What the switch is with that timing: an upgrade at the period's end is a scheduled one.
    const { kind } = resolved;
    const pending = await db.BillingInvoice.findOne({ where: { subscriptionId: subscription.id, status: 'pending' }, transaction });
    if (pending && (!locked || locked.id !== pending.id)) throw busy();
    const open = await db.PlanSwitch.findOne({ where: { subscriptionId: subscription.id, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });

    // The plan and cycle the store is on: whatever waits is cancelled.
    if (kind === 'none') {
      if (!open) return { kind: 'none', created: false, changed: false, sw: null, invoice: null };
      await closeOpen(open, locked, 'cancelled', req, transaction);
      await settlement.audit(open, 'subscription.plan_switch_cancel', { before: { status: 'open' }, after: { status: 'cancelled' }, actorUserId: req.user.id, req }, transaction);
      return { kind: 'none', created: false, changed: true, sw: open, invoice: null };
    }

    const charged = kind === 'upgrade' || kind === 'move';
    const amountDue = await amountDueFor(kind, subscription, target, cycle, transaction);
    const reason = decision.reason || null;

    // The same request again: what waits is handed back (a charge only while its price is still the same).
    const sameTarget = open && open.toPlanId === target.id && open.toBillingCycle === cycle && open.kind === kind;
    if (sameTarget && charged && open.status === 'pending' && pending && open.billingInvoiceId === pending.id && Number(pending.amount) === amountDue) {
      return { kind, created: false, changed: false, sw: open, invoice: pending };
    }
    if (sameTarget && kind === 'scheduled' && open.status === 'scheduled') {
      return { kind: 'scheduled', created: false, changed: false, sw: open, invoice: null };
    }

    if (pending && (await proofWaiting(pending.id, transaction))) throw proofUnderReview(pending.id);
    if (charged && !(await paymentMethods.anyOffered(target.currency))) throw noPaymentMethod(target.currency);
    if (expectedAmount != null && expectedAmount !== amountDue) throw amountChanged(amountDue, target.currency);

    // What this replaces: the switch waiting, and any charge still pending.
    const replaced = { switchId: open ? open.id : null, invoiceId: pending ? pending.id : null };
    if (open) await closeOpen(open, locked, 'replaced', req, transaction);
    if (pending && pending.status === 'pending') {
      await pending.reload({ transaction });
      if (pending.status === 'pending') {
        if (pending.targetPlanId) await charges.voidMoveCharge(pending, 'replaced', { actorUserId: req.user.id, req }, transaction);
        else await charges.voidRenewalCharge(pending, { actorUserId: req.user.id, req }, transaction);
      }
    }

    const base = {
      workspaceId,
      subscriptionId: subscription.id,
      kind,
      fromPlanId: current ? current.id : null,
      fromBillingCycle: subscription.billingCycle,
      toPlanId: target.id,
      toBillingCycle: cycle,
      requestedByUserId: req.user.id,
    };
    let invoice = null;
    let sw;
    if (kind === 'upgrade' || kind === 'move') {
      // The new plan's full price, for a full period that starts when it is paid.
      invoice = await charges.createMoveChargeInTransaction(subscription, target, cycle, { now, req }, transaction);
      const priced = { amount: Number(invoice.amount), grossAmount: Number(invoice.grossAmount), discountAmount: Number(invoice.discountAmount), currency: invoice.currency };
      sw = await db.PlanSwitch.create(
        {
          ...base,
          status: 'pending',
          billingInvoiceId: invoice.id,
          quote: kind === 'upgrade' ? { ...priced, pricing: 'full_period', timing: 'now', reason } : { ...priced, reason },
        },
        { transaction }
      );
    } else if (kind === 'scheduled') {
      sw = await db.PlanSwitch.create(
        { ...base, status: 'scheduled', effectiveAt: decision.effectiveAt, quote: { reason, ...(decision.kind === 'upgrade' ? { timing: 'period_end' } : {}) } },
        { transaction }
      );
    } else {
      const before = { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd };
      await applyTo(subscription, target, cycle, { free: decision.free, payPerOrder: decision.payPerOrder }, transaction, now);
      sw = await db.PlanSwitch.create({ ...base, status: 'applied', effectiveAt: now, appliedAt: now, quote: { reason } }, { transaction });
      await settlement.audit(
        sw,
        'subscription.plan_switch_applied',
        { before, after: { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd }, metadata: { reason }, actorUserId: req.user.id, req },
        transaction
      );
    }
    await settlement.audit(
      sw,
      'subscription.plan_switch_request',
      {
        after: { kind: sw.kind, status: sw.status, effectiveAt: sw.effectiveAt || null },
        metadata: { reason, timing: resolved.timing, amountDue, currency: target.currency, replacedSwitchId: replaced.switchId, replacedInvoiceId: replaced.invoiceId },
        actorUserId: req.user.id,
        req,
      },
      transaction
    );
    return { kind, created: true, changed: kind === 'immediate', sw, invoice };
  });

  return {
    kind: outcome.kind,
    created: outcome.created,
    changed: outcome.changed,
    switch: outcome.sw ? await withPlans(outcome.sw) : null,
    invoice: outcome.invoice ? merchantPlans().serializeInvoice(outcome.invoice) : null,
    plans: await merchantPlans().listPlans(workspaceId),
  };
}

// ----------------------------------------------------------------- cancel

/**
 * POST /workspaces/:id/billing/plan-switch/cancel — the switch waiting is
 * cancelled; with none, a pay-per-order move waiting is (as
 * /plan-move/cancel). Nothing waiting: `cancelled: false`. Not behind the
 * flag: it only ever undoes.
 */
async function cancel(workspaceId, req) {
  const result = await db.sequelize.transaction(async (transaction) => {
    const locked = await merchantPlans().lockPendingCharge(workspaceId, transaction);
    const subscription = await loadSubscription(workspaceId, transaction, { lock: true });
    const open = await db.PlanSwitch.findOne({ where: { subscriptionId: subscription.id, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });
    if (!open) return null;
    const before = { status: open.status };
    await closeOpen(open, locked, 'cancelled', req, transaction);
    await settlement.audit(open, 'subscription.plan_switch_cancel', { before, after: { status: open.status }, actorUserId: req.user.id, req }, transaction);
    return open;
  });
  if (!result) {
    const moved = await merchantPlans().cancelPlanMove(workspaceId, req);
    return { cancelled: moved.cancelled, switch: null, plans: moved.plans };
  }
  return { cancelled: true, switch: await withPlans(result), plans: await merchantPlans().listPlans(workspaceId) };
}

// ---------------------------------------------------------- the plans list

/**
 * For GET /billing/plans: whether the switch is on, how this subscription
 * changes plan (rules.selfServeMode; null while off) and the switch waiting.
 * The waiting one is shown with the flag off too, so it can be cancelled.
 */
async function summaryFor(subscription) {
  const open = await db.PlanSwitch.findOne({ where: { subscriptionId: subscription.id, status: OPEN } });
  let mode = null;
  let reason = null;
  if (enabled()) {
    const current = subscription.planId ? await db.Plan.findByPk(subscription.planId, { attributes: ['id', 'perOrderFeeAmount'] }) : null;
    ({ mode, reason } = rules.selfServeMode({ subscription, current, specialTerms: await specialTermsRunning(subscription, null, new Date()) }));
  }
  return { enabled: enabled(), mode, reason, open: open ? await withPlans(open) : null };
}

// ------------------------------------------------------- someone else acts

/**
 * The console changed the subscription under a switch waiting (activated a
 * period, changed its plan, ended it, changed its cycle): that switch no
 * longer fits and is dropped with `reason`, its charge voided (replaced) so
 * the merchant is not asked to pay for it. Called with the subscription
 * locked. Resolves the dropped switch, or null.
 */
async function dropOpen(subscription, reason, { actorUserId = null, req = null } = {}, transaction) {
  const open = await db.PlanSwitch.findOne({ where: { subscriptionId: subscription.id, status: OPEN }, transaction, lock: transaction.LOCK.UPDATE });
  if (!open) return null;
  const invoice = open.status === 'pending' && open.billingInvoiceId ? await db.BillingInvoice.findByPk(open.billingInvoiceId, { transaction }) : null;
  await settlement.drop(open, reason, transaction, { actorUserId, req });
  if (invoice && invoice.status === 'pending') await charges.voidMoveCharge(invoice, 'replaced', { actorUserId, req }, transaction);
  return open;
}

// --------------------------------------------------------- the hourly job

/**
 * An upgrade's (or a move's) charge left unpaid chargeExpiryHours is voided
 * as expired, unless a transfer's proof for it is with the console (the
 * review decides; a rejected proof lets it expire at the next run). The
 * charge is locked first, so a payment at the same moment either settles it
 * or finds it void (and is applied or credited).
 */
async function expireUnpaid({ now = new Date(), limit = 200 } = {}) {
  const cutoff = new Date(now.getTime() - env.billing.planSwitch.chargeExpiryHours * 60 * 60 * 1000);
  const stale = await db.PlanSwitch.findAll({
    where: { status: 'pending', createdAt: { [db.Sequelize.Op.lt]: cutoff } },
    attributes: ['id', 'billingInvoiceId'],
    order: [['createdAt', 'ASC']],
    limit,
  });
  let expired = 0;
  for (const { id, billingInvoiceId } of stale) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const done = await db.sequelize.transaction(async (transaction) => {
        const invoice = billingInvoiceId ? await db.BillingInvoice.findByPk(billingInvoiceId, { transaction, lock: transaction.LOCK.UPDATE }) : null;
        const sw = await db.PlanSwitch.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!sw || sw.status !== 'pending') return false;
        if (!invoice || invoice.status === 'void') {
          await sw.update({ status: 'expired', endedAt: now }, { transaction });
          return true;
        }
        if (invoice.status !== 'pending' || (await proofWaiting(invoice.id, transaction))) return false;
        return charges.voidMoveCharge(invoice, 'expired', {}, transaction);
      });
      if (done) expired += 1;
    } catch (err) {
      logger.error(`[plan-switch] expiring switch ${id} failed: ${err.message}`);
    }
  }
  return expired;
}

/**
 * The renewal an upgrade waiting for the period's end leaves behind when it
 * takes effect: the next period's charge at the new plan's price
 * (subscriptionChargeService.createCharge, which hands back a charge already
 * pending). Logged, never thrown: the plan has changed either way, and the
 * merchant can still pay from the Invoices tab.
 */
async function writeRenewal(workspaceId, switchId, now) {
  try {
    const { invoice, created } = await charges.createCharge(workspaceId, { now });
    if (created) logger.info(`[plan-switch] switch ${switchId}: renewal ${invoice.id} written at the new plan's price`);
  } catch (err) {
    logger.error(`[plan-switch] switch ${switchId}: the renewal could not be written: ${err.message}`);
  }
}

/**
 * A scheduled switch whose moment has come: the store moves to its plan and
 * cycle (a free plan as an open-ended active period) while it still fits —
 * still on the plan and cycle it was asked from, the plan still there —
 * otherwise it is dropped with why. The period is not touched: the renewal
 * that follows was priced on the new plan already (nextChargeTerms).
 */
async function applyDue({ now = new Date(), limit = 200 } = {}) {
  const due = await db.PlanSwitch.findAll({
    where: { status: 'scheduled', effectiveAt: { [db.Sequelize.Op.lte]: now } },
    attributes: ['id', 'subscriptionId'],
    order: [['effectiveAt', 'ASC']],
    limit,
  });
  const result = { applied: 0, dropped: 0 };
  for (const { id, subscriptionId } of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await db.sequelize.transaction(async (transaction) => {
        const subscription = await db.Subscription.findByPk(subscriptionId, { transaction, lock: transaction.LOCK.UPDATE });
        const sw = await db.PlanSwitch.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!sw || sw.status !== 'scheduled' || new Date(sw.effectiveAt).getTime() > now.getTime()) return null;
        const target = sw.toPlanId ? await db.Plan.findByPk(sw.toPlanId, { transaction }) : null;
        const fit = subscription ? rules.scheduleStillApplies({ subscription, sw, targetExists: Boolean(target) }) : { applies: false, reason: 'subscription_gone' };
        if (!fit.applies) {
          await settlement.drop(sw, fit.reason, transaction);
          return 'dropped';
        }
        // An upgrade waiting for the period's end gets its renewal at the new
        // price, unless the period after it is already paid at that price.
        const renews = Boolean(sw.quote && sw.quote.reason === 'upgrade') && !(await billedOnSchedule(sw, transaction));
        const before = { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd };
        await applyTo(subscription, target, sw.toBillingCycle, { free: planPrice(target, sw.toBillingCycle) === 0 }, transaction, now);
        await settlement.markApplied(sw, transaction);
        await settlement.audit(
          sw,
          'subscription.plan_switch_applied',
          {
            before,
            after: { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status, currentPeriodEnd: subscription.currentPeriodEnd },
            metadata: { by: 'schedule', effectiveAt: sw.effectiveAt, renews },
          },
          transaction
        );
        return renews ? { outcome: 'applied', renew: subscription.workspaceId } : 'applied';
      });
      const done = outcome && typeof outcome === 'object' ? outcome.outcome : outcome;
      if (done) result[done] += 1;
      if (outcome && outcome.renew) {
        // The renewal is its own step: a failure leaves the switch applied and is logged.
        // eslint-disable-next-line no-await-in-loop
        await writeRenewal(outcome.renew, id, now);
      }
    } catch (err) {
      logger.error(`[plan-switch] applying switch ${id} failed: ${err.message}`);
    }
  }
  return result;
}

/** The hourly billing job (billing.plan_switches). Follows the rows, not PLAN_SWITCH_ENABLED. */
async function runDue({ now = new Date(), limit = 200 } = {}) {
  const expired = await expireUnpaid({ now, limit });
  const { applied, dropped } = await applyDue({ now, limit });
  return { expired, applied, dropped };
}

module.exports = {
  enabled,
  disabledError,
  preview,
  start,
  cancel,
  summaryFor,
  serialize,
  applyTo,
  dropOpen,
  expireUnpaid,
  applyDue,
  runDue,
};
