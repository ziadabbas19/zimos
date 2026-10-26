'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { ConflictError, NotFoundError } = require('../../core/errors/AppError');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const referralCodes = require('../referrals/referralCodeService');
const commissions = require('../referrals/commissionService');
const { planPrice, addBillingPeriod } = require('./planPricing');
const specialTerms = require('./specialTermsService');
const manualPricing = require('./manualPricing');
const planSwitches = require('./planSwitchSettlement');
const switchRules = require('./planSwitchRules');
const realtimeEvents = require('../realtime/realtimeEvents');

/**
 * Subscription charges: one billing_invoices row per charge, the first and
 * every renewal alike.
 *
 * No payment gateway is connected for subscriptions yet. This is the seam a
 * gateway integration (a checkout, a renewal job) plugs into, and what the
 * platform console's "record payment" uses meanwhile. Two steps:
 *
 *   1. `createCharge` prices the next period and writes a pending invoice:
 *      the plan's price for the billing cycle, less the discount of the
 *      referral code attached to the subscription if that code is active
 *      now. The invoice records the gross price, the discount and the code.
 *      The invoice id is what a gateway should carry as its reference.
 *
 *   2. The charge is settled. Both ways in end in `settlePaid`, so they
 *      behave identically:
 *        - `markChargePaid` / `markChargeFailed`, reached through the signed
 *          billing webhook (`invoice.paid`, `invoice.payment_failed`, see
 *          billingService). Idempotent: a redelivered event changes nothing.
 *        - `recordManualPayment`, a platform user recording a payment
 *          received outside any gateway: the amount actually received, and
 *          the date it arrived (default now; may be in the past).
 *
 *      A manual payment — only a manual one — can be undone with
 *      `reverseManualPayment`; gateway money really moved.
 *
 * The referral code is judged when the charge is PAID, not when it was
 * priced. At payment the code the charge was priced with is looked up again
 * (`payableNow`): if it is still active, its discount as configured now
 * applies and the paid charge writes one commission ledger row, in the same
 * transaction; if it has been deactivated, the charge is re-priced at the
 * full plan price, carries no code, and earns nothing. A charge priced with
 * no active code is not given one at payment — a code attached or
 * reactivated later applies from the next charge.
 */


/** A code counts only while it exists and is active. */
function usableCode(code) {
  return code && code.active ? code : null;
}

/**
 * What the next charge would be for this subscription and plan: the gross
 * price, the referral discount (active code only) and the amount due. The
 * gross price is the plan's price for the billing cycle (annual = 10 ×
 * monthly), or a special-terms price override while one has charges left.
 * Used for the real charge and for every preview, so they can never
 * disagree. `override` is passed by createCharge, which has it locked;
 * otherwise it is looked up.
 */
async function priceCharge(subscription, plan, transaction, { override } = {}) {
  const term = override === undefined ? await specialTerms.activePriceOverride(subscription.id, { transaction }) : override;
  const useOverride = Boolean(term && term.currency === plan.currency);
  const grossAmount = useOverride ? Number(term.priceAmount) : planPrice(plan, subscription.billingCycle);
  const code = subscription.referralCodeId
    ? await db.ReferralCode.findByPk(subscription.referralCodeId, { transaction })
    : null;
  const usable = usableCode(code);
  const discountAmount = referralCodes.discountFor(usable, grossAmount, plan.currency);
  return {
    grossAmount,
    discountAmount,
    amount: grossAmount - discountAmount,
    currency: plan.currency,
    referralCodeId: usable ? usable.id : null,
    specialTermsId: useOverride ? term.id : null,
  };
}

/**
 * What an unpaid charge comes to if it is paid now: the code it was priced
 * with, re-checked as it stands at this moment. `codeLapsed` says the charge
 * was priced with a code that is no longer usable, so the discount is gone.
 */
async function payableNow(invoice, transaction) {
  const grossAmount = Number(invoice.grossAmount);
  const pricedWith = invoice.referralCodeId
    ? await db.ReferralCode.findByPk(invoice.referralCodeId, { transaction })
    : null;
  const usable = usableCode(pricedWith);
  const discountAmount = referralCodes.discountFor(usable, grossAmount, invoice.currency);
  return {
    grossAmount,
    discountAmount,
    amount: grossAmount - discountAmount,
    referralCodeId: usable ? usable.id : null,
    codeLapsed: Boolean(invoice.referralCodeId) && !usable,
  };
}

/** `payableNow`'s shape for a price frozen at checkout (see settlePaid). */
async function frozenPayable(frozen, transaction) {
  const pricedWith = frozen.referralCodeId ? await db.ReferralCode.findByPk(frozen.referralCodeId, { transaction }) : null;
  const usable = usableCode(pricedWith);
  return {
    discountAmount: Number(frozen.discountAmount),
    amount: Number(frozen.amount),
    referralCodeId: usable ? usable.id : null,
    codeLapsed: Boolean(frozen.referralCodeId) && !usable,
  };
}

/**
 * The next charge of a subscription with no pending one: its plan, period
 * and price, as createCharge writes it and quoteCharge shows it. 409 NO_PLAN
 * or PLAN_IS_FREE. The special-terms price override is locked only with
 * `lock` (createCharge, which uses one of its charges). A downgrade (or a
 * cycle change) the merchant scheduled for the end of the paid period prices
 * the period that starts then (billing/planSwitchSettlement.scheduledFor);
 * the plan itself changes at that moment (the hourly billing job).
 */
async function nextChargeTerms(subscription, transaction, { now, lock = false }) {
  const current = subscription.planId ? await db.Plan.findByPk(subscription.planId, { transaction }) : null;
  if (!current) throw new ConflictError('This subscription has no plan to charge for.', 'NO_PLAN');

  const lastPaid = await db.BillingInvoice.findOne({
    where: { subscriptionId: subscription.id, status: 'paid' },
    order: [['periodEnd', 'DESC']],
    transaction,
  });
  const compEnd = await specialTerms.compCoveredUntil(subscription.id, transaction);
  const coveredUntil = Math.max(lastPaid ? new Date(lastPaid.periodEnd).getTime() : 0, compEnd ? compEnd.getTime() : 0);
  const periodStart = coveredUntil > now.getTime() ? new Date(coveredUntil) : now;

  const scheduled = await planSwitches.scheduledFor(subscription, periodStart, transaction);
  const plan = scheduled ? scheduled.plan : current;
  const billingCycle = scheduled ? scheduled.billingCycle : subscription.billingCycle;
  if (planPrice(plan, billingCycle) <= 0) {
    throw new ConflictError('This plan is free, so there is nothing to charge.', 'PLAN_IS_FREE');
  }
  const override = await specialTerms.activePriceOverride(subscription.id, { transaction, lock });
  const pricing = await priceCharge(
    scheduled ? { id: subscription.id, billingCycle, referralCodeId: subscription.referralCodeId } : subscription,
    plan,
    transaction,
    { override }
  );
  return { pricing, override, periodStart, periodEnd: addBillingPeriod(periodStart, billingCycle) };
}

/**
 * Prices the next period and writes it as a pending invoice. A subscription
 * already holding a pending invoice gets that one back (`created: false`):
 * one open charge at a time, which a unique index also enforces.
 *
 * The period continues from whatever covers the subscription last — the last
 * paid charge, or a special-terms free-months window — while that is still
 * running; otherwise it starts now. So comped months are never billed. A
 * special-terms price override prices the charge and uses up one of its
 * charges. With `req`, a created charge is audited: as a platform-level entry
 * for the console's action, in the workspace when `byMerchant` (the merchant
 * pressing Pay, see onlineBillingService, or sending a transfer's proof, see
 * paymentProofService).
 */
async function createCharge(workspaceId, options = {}) {
  return db.sequelize.transaction((transaction) => createChargeInTransaction(workspaceId, options, transaction));
}

/** createCharge inside the caller's transaction (a proof that writes its charge). */
async function createChargeInTransaction(workspaceId, { now = new Date(), req = null, byMerchant = false } = {}, transaction) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!subscription) throw new NotFoundError('Subscription');

  const pending = await db.BillingInvoice.findOne({
    where: { subscriptionId: subscription.id, status: 'pending' },
    transaction,
  });
  if (pending) return { invoice: pending, created: false };
  // A free or discounted manual subscription (billing/manualPricing) is never
  // charged at the plan's price, also after its period ran out: the console
  // sets it to paid again first.
  if (manualPricing.isManuallyPriced(subscription)) {
    throw new ConflictError('This subscription is free or discounted by the platform, so it is not charged here.', 'MANUAL_PRICING');
  }

  const { pricing, override, periodStart, periodEnd } = await nextChargeTerms(subscription, transaction, { now, lock: true });
  if (pricing.specialTermsId) await override.increment('chargesUsed', { by: 1, transaction });

  const invoice = await db.BillingInvoice.create(
    {
      workspaceId,
      subscriptionId: subscription.id,
      ...pricing,
      status: 'pending',
      periodStart,
      periodEnd,
    },
    { transaction }
  );
  if (req) {
    await recordAudit({
      workspaceId: byMerchant ? workspaceId : null,
      actorUserId: req.user.id,
      action: 'billing_invoice.create',
      entityType: 'BillingInvoice',
      entityId: invoice.id,
      after: chargeAuditState(invoice),
      metadata: { workspaceId },
      req,
      transaction,
    });
  }
  return { invoice, created: true };
}

/**
 * A pay-per-order store's move to `plan` on `billingCycle`
 * (merchantPlansService.requestPlanMove, which holds the subscription row
 * locked and has checked there is no pending charge): one pending charge,
 * priced as any charge of that plan and cycle (the referral code, a
 * special-terms price), carrying the plan it moves to. Nothing about the
 * subscription changes until it is paid (settlePaid).
 */
async function createMoveChargeInTransaction(subscription, plan, billingCycle, { now = new Date(), req = null } = {}, transaction) {
  if (manualPricing.isManuallyPriced(subscription)) {
    throw new ConflictError('This subscription is free or discounted by the platform, so it is not charged here.', 'MANUAL_PRICING');
  }
  if (planPrice(plan, billingCycle) <= 0) {
    throw new ConflictError('This plan is free, so there is nothing to charge.', 'PLAN_IS_FREE');
  }
  const override = await specialTerms.activePriceOverride(subscription.id, { transaction, lock: true });
  const pricing = await priceCharge(
    { id: subscription.id, billingCycle, referralCodeId: subscription.referralCodeId },
    plan,
    transaction,
    { override }
  );
  if (pricing.specialTermsId) await override.increment('chargesUsed', { by: 1, transaction });
  const invoice = await db.BillingInvoice.create(
    {
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      ...pricing,
      status: 'pending',
      // Shown as from now; the period really starts when it is paid.
      periodStart: now,
      periodEnd: addBillingPeriod(now, billingCycle),
      targetPlanId: plan.id,
      targetBillingCycle: billingCycle,
    },
    { transaction }
  );
  if (req) {
    await recordAudit({
      workspaceId: subscription.workspaceId,
      actorUserId: req.user.id,
      action: 'billing_invoice.create',
      entityType: 'BillingInvoice',
      entityId: invoice.id,
      after: chargeAuditState(invoice),
      metadata: { workspaceId: subscription.workspaceId, targetPlanId: plan.id, targetBillingCycle: billingCycle },
      req,
      transaction,
    });
  }
  return invoice;
}

/**
 * What createCharge would do now, writing nothing: the pending invoice if
 * there is one (`{ pending }`), otherwise the next charge as it would be
 * written (`{ quote }`: its price and period). Same errors as createCharge.
 */
async function quoteCharge(workspaceId, { now = new Date() } = {}) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId } });
  if (!subscription) throw new NotFoundError('Subscription');
  const pending = await db.BillingInvoice.findOne({ where: { subscriptionId: subscription.id, status: 'pending' } });
  if (pending) return { pending };
  const { pricing, periodStart, periodEnd } = await nextChargeTerms(subscription, null, { now });
  return { quote: { ...pricing, periodStart, periodEnd } };
}

function chargeAuditState(invoice) {
  return {
    status: invoice.status,
    paidAt: invoice.paidAt || null,
    paymentSource: invoice.paymentSource || null,
    grossAmount: Number(invoice.grossAmount),
    discountAmount: Number(invoice.discountAmount),
    amount: Number(invoice.amount),
    amountPaid: invoice.amountPaid == null ? null : Number(invoice.amountPaid),
    currency: invoice.currency,
    referralCodeId: invoice.referralCodeId,
    paymentNote: invoice.paymentNote || null,
  };
}

/**
 * The one charge-paid path, for the webhook and for a payment recorded by
 * hand alike. Runs on a locked, unpaid invoice inside the caller's
 * transaction:
 *
 *   - re-prices it against the code it was priced with, as that code stands
 *     now (see `payableNow`) — a lapsed code loses its discount and its code;
 *   - marks it paid, with what was received (`amountPaid`, defaulting to the
 *     amount due), where the payment came from (`source`: 'gateway' | 'manual')
 *     and, for a manual one, who recorded it and when;
 *   - makes the subscription active for the invoice's period;
 *   - writes the commission ledger row if a usable code is still on it.
 *
 * `frozen` is an online payment's price, fixed when the merchant pressed Pay
 * (onlineBillingService): { discountAmount, amount, referralCodeId }. The
 * charge is settled at that price even if the code has lapsed since — the
 * merchant paid what they were shown. Whether the code still earns a
 * commission is judged now, as for any payment: a lapsed code keeps its
 * discount on the charge but is taken off it and earns nothing.
 */
async function settlePaid(
  invoice,
  { paidAt, amountPaid, externalReference, note, recordedByUserId, source, frozen = null },
  transaction
) {
  // Renewed: the locked orders left 'due' open for good once this commits (orders/orderLock; no fee, no money moved).
  require('./confirmFeeService').releaseDueAfterCommit(transaction, invoice.workspaceId);
  // A move's charge voided before the money came: applied or credited, never lost.
  if (invoice.status === 'void') {
    return settleLateMovePayment(invoice, { paidAt, amountPaid, externalReference, note, recordedByUserId, source, frozen }, transaction);
  }
  // A plan switch's charge paid after the store changed under it (the
  // console changed its plan, say): the switch is dropped, the charge voided,
  // and the money credited instead (billing/planSwitchSettlement).
  if (invoice.targetPlanId) {
    const fit = await planSwitches.paymentFit(invoice, transaction);
    if (!fit.applies) {
      await planSwitches.drop(fit.sw, fit.reason, transaction);
      await voidMoveCharge(invoice, 'replaced', {}, transaction);
      return settleLateMovePayment(invoice, { paidAt, amountPaid, externalReference, note, recordedByUserId, source, frozen }, transaction);
    }
  }
  const earlierPaid = await db.BillingInvoice.count({
    where: { subscriptionId: invoice.subscriptionId, status: 'paid' },
    transaction,
  });
  const payable = frozen ? await frozenPayable(frozen, transaction) : await payableNow(invoice, transaction);

  await invoice.update(
    {
      status: 'paid',
      paidAt,
      failureReason: null,
      discountAmount: payable.discountAmount,
      amount: payable.amount,
      referralCodeId: payable.referralCodeId,
      amountPaid: amountPaid == null ? payable.amount : amountPaid,
      paymentSource: source,
      paymentRecordedAt: source === 'manual' ? new Date() : null,
      ...(externalReference ? { externalReference } : {}),
      ...(note ? { paymentNote: note } : {}),
      ...(recordedByUserId ? { recordedByUserId } : {}),
    },
    { transaction }
  );

  const subscription = await db.Subscription.findByPk(invoice.subscriptionId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  // Kept so a reversal can tell whether this payment is what made the
  // subscription active.
  await invoice.update(
    {
      subscriptionBeforePayment: {
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        // A move's reversal puts the plan back too.
        ...(invoice.targetPlanId ? { planId: subscription.planId, billingCycle: subscription.billingCycle } : {}),
      },
    },
    { transaction }
  );
  if (invoice.targetPlanId) {
    // An upgrade (its full price) or a move (pay per order, or from a free
    // plan) starts a full period of the new plan from now; an upgrade of the
    // old prorated kind kept the paid period.
    const sw = await planSwitches.switchOfCharge(invoice, transaction);
    if (sw && sw.kind === 'upgrade' && !switchRules.fullPeriodUpgrade(sw)) await planSwitches.applyUpgrade(invoice, subscription, sw, transaction);
    else {
      const before = { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status };
      await switchPlanForMove(invoice, subscription, transaction);
      // A plan switch's charge: the switch's own audit entry too, as for the old prorated kind.
      if (sw) {
        await planSwitches.audit(
          sw,
          'subscription.plan_switch_applied',
          {
            before,
            after: { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status },
            metadata: { paymentSource: invoice.paymentSource, amountPaid: Number(invoice.amountPaid), currency: invoice.currency, currentPeriodStart: subscription.currentPeriodStart, currentPeriodEnd: subscription.currentPeriodEnd },
            actorUserId: invoice.recordedByUserId || null,
          },
          transaction
        );
      }
    }
    if (sw) await planSwitches.markApplied(sw, transaction);
  } else {
    // A late payment for an earlier period never moves the period backwards.
    const extendsPeriod = new Date(invoice.periodEnd) > new Date(subscription.currentPeriodEnd);
    await subscription.update(
      {
        status: 'active',
        graceUntil: null,
        ...(extendsPeriod ? { currentPeriodStart: invoice.periodStart, currentPeriodEnd: invoice.periodEnd } : {}),
      },
      { transaction }
    );
  }

  const commission = await commissions.recordForPaidInvoice(invoice, { isFirstPayment: earlierPaid === 0 }, transaction);
  logger.info(
    `billing invoice ${invoice.id} paid (${invoice.amountPaid} of ${invoice.amount} ${invoice.currency} due)` +
      (payable.codeLapsed ? ', referral code no longer active: no discount, no commission' : '') +
      (commission ? `, commission row ${commission.id}` : '')
  );
  // A live update to the console, with REALTIME_ENABLED only (realtime/realtimeEvents).
  await realtimeEvents.record(
    transaction,
    'subscription.paid',
    { workspaceId: invoice.workspaceId, billingInvoiceId: invoice.id },
    { aggregateType: 'billing_invoice', aggregateId: invoice.id }
  );
  return { commission, codeLapsed: payable.codeLapsed };
}

/**
 * A pending move's charge stops asking for money (`reason`: cancelled by the
 * merchant, replaced by another move, expired unpaid): void, with any online
 * checkout for it superseded. The subscription is not touched. The caller
 * holds the charge locked. Resolves false when it was no longer a pending move.
 */
async function voidMoveCharge(invoice, reason, { actorUserId = null, req = null } = {}, transaction) {
  if (!invoice || invoice.status !== 'pending' || !invoice.targetPlanId) return false;
  await invoice.update({ status: 'void', voidedAt: new Date(), voidReason: reason }, { transaction });
  const [checkoutsSuperseded] = await db.BillingPaymentAttempt.update(
    { status: 'superseded' },
    { where: { billingInvoiceId: invoice.id, status: db.BillingPaymentAttempt.IN_PROGRESS }, transaction }
  );
  // A plan switch waiting for this charge ends the same way.
  const switchClosed = await planSwitches.closeForVoidedCharge(invoice, reason, transaction);
  await recordAudit({
    workspaceId: invoice.workspaceId,
    actorUserId,
    action: 'subscription.plan_move_void',
    entityType: 'BillingInvoice',
    entityId: invoice.id,
    before: { status: 'pending' },
    after: { status: 'void', reason },
    metadata: {
      targetPlanId: invoice.targetPlanId,
      targetBillingCycle: invoice.targetBillingCycle,
      amount: Number(invoice.amount),
      checkoutsSuperseded,
      ...(switchClosed ? { planSwitchClosed: true } : {}),
    },
    req,
    transaction,
  });
  return true;
}

/**
 * A pending renewal that gives way to a plan switch (billing/planSwitchService):
 * it was priced for the plan the store is leaving. Only one nobody is paying
 * by transfer (the caller checks no proof waits for it): void (replaced),
 * any online checkout for it superseded, and a special-terms charge it used
 * given back. Money that still arrives for it is credited
 * (settleLateMovePayment). The caller holds the charge locked. Resolves
 * false when it was no longer a pending renewal.
 */
async function voidRenewalCharge(invoice, { actorUserId = null, req = null } = {}, transaction) {
  if (!invoice || invoice.status !== 'pending' || invoice.targetPlanId) return false;
  await invoice.update({ status: 'void', voidedAt: new Date(), voidReason: 'replaced' }, { transaction });
  const [checkoutsSuperseded] = await db.BillingPaymentAttempt.update(
    { status: 'superseded' },
    { where: { billingInvoiceId: invoice.id, status: db.BillingPaymentAttempt.IN_PROGRESS }, transaction }
  );
  if (invoice.specialTermsId) {
    await db.SubscriptionTerm.decrement('chargesUsed', { by: 1, where: { id: invoice.specialTermsId, chargesUsed: { [db.Sequelize.Op.gt]: 0 } }, transaction });
  }
  await recordAudit({
    workspaceId: invoice.workspaceId,
    actorUserId,
    action: 'billing_invoice.void',
    entityType: 'BillingInvoice',
    entityId: invoice.id,
    before: { status: 'pending' },
    after: { status: 'void', reason: 'replaced' },
    metadata: { amount: Number(invoice.amount), currency: invoice.currency, periodStart: invoice.periodStart, checkoutsSuperseded, by: 'plan_switch' },
    req,
    transaction,
  });
  return true;
}

/**
 * Voids a pending charge for `reason` (planSwitchRules.VOID_REASONS): the
 * merchant cancelled it (cancelled_by_merchant), the console voided it
 * (voided_by_admin, with its `note`), or its payment failed
 * (payment_failed). A renewal, an upgrade's or a move's alike. Any online
 * checkout for it is superseded, a special-terms charge it used given back,
 * and a plan switch waiting for it ends as the reason says
 * (planSwitchRules.switchEndForVoid). The subscription is not touched. Money
 * that still arrives for it is applied or credited (settleLateMovePayment).
 * The caller holds the charge locked and has checked that no transfer's
 * proof waits for it. Resolves false when it was no longer pending.
 */
async function voidPendingCharge(invoice, reason, { actorUserId = null, req = null, note = null } = {}, transaction) {
  if (!invoice || invoice.status !== 'pending') return false;
  const before = chargeAuditState(invoice);
  await invoice.update({ status: 'void', voidedAt: new Date(), voidReason: reason, voidNote: note || null }, { transaction });
  const [checkoutsSuperseded] = await db.BillingPaymentAttempt.update(
    { status: 'superseded' },
    { where: { billingInvoiceId: invoice.id, status: db.BillingPaymentAttempt.IN_PROGRESS }, transaction }
  );
  if (invoice.specialTermsId) {
    await db.SubscriptionTerm.decrement('chargesUsed', { by: 1, where: { id: invoice.specialTermsId, chargesUsed: { [db.Sequelize.Op.gt]: 0 } }, transaction });
  }
  const switchClosed = await planSwitches.closeForVoidedCharge(invoice, reason, transaction);
  await recordAudit({
    workspaceId: invoice.workspaceId,
    actorUserId,
    action: 'billing_invoice.void',
    entityType: 'BillingInvoice',
    entityId: invoice.id,
    before,
    after: { status: 'void', reason, note: note || null },
    metadata: {
      amount: Number(invoice.amount),
      currency: invoice.currency,
      periodStart: invoice.periodStart,
      targetPlanId: invoice.targetPlanId || null,
      checkoutsSuperseded,
      ...(switchClosed ? { planSwitchClosed: true } : {}),
    },
    req,
    transaction,
  });
  return true;
}

/**
 * Whether the console may void this charge (POST /admin/charges/:id/void):
 * PLAN_SWITCH_ENABLED on, the charge pending, and no transfer's proof for it
 * waiting for review. `waitingProofs` is counted when not given.
 */
async function voidableByAdmin(invoice, waitingProofs = null) {
  if (env.billing.planSwitch.enabled !== true || invoice.status !== 'pending') return false;
  const waiting = waitingProofs == null ? await db.PaymentProof.count({ where: { billingInvoiceId: invoice.id, status: 'pending' } }) : waitingProofs;
  return switchRules.cancellableByMerchant({ enabled: true, status: invoice.status, waitingProofs: waiting });
}

/**
 * Money arrived for a move's charge after it was voided (a transfer's proof
 * approved later, a checkout paid late, a payment recorded in the console).
 * It is never lost:
 *   - applied, when the store is still on pay per order, the plan is still on
 *     offer and no other charge is pending: the charge is paid and the plan
 *     switches as for any move;
 *   - otherwise credited to the prepaid balance once per payment
 *     (move_payment_credit, not a top-up, so not refundable by request); the
 *     charge stays void and records what arrived.
 */
async function settleLateMovePayment(invoice, args, transaction) {
  const subscription = await db.Subscription.findByPk(invoice.subscriptionId, { transaction, lock: transaction.LOCK.UPDATE });
  // A plan switch's charge (billing/planSwitchSettlement) has its own test:
  // the store still as it was priced, the plan on offer, nothing else waiting.
  const sw = await planSwitches.switchOfCharge(invoice, transaction);
  let applicable;
  if (sw) {
    applicable = subscription ? (await planSwitches.lateFit(invoice, sw, subscription, transaction)).applies : false;
  } else {
    const [current, target, otherPending] = await Promise.all([
      subscription && subscription.planId ? db.Plan.findByPk(subscription.planId, { transaction }) : null,
      invoice.targetPlanId ? db.Plan.findByPk(invoice.targetPlanId, { transaction }) : null,
      db.BillingInvoice.findOne({ where: { subscriptionId: invoice.subscriptionId, status: 'pending' }, attributes: ['id'], transaction }),
    ]);
    applicable = Boolean(
      current &&
        Number(current.perOrderFeeAmount) > 0 &&
        target &&
        target.isActive &&
        target.isPublic &&
        !(Number(target.perOrderFeeAmount) > 0) &&
        !otherPending
    );
  }
  const wasVoided = { reason: invoice.voidReason, at: invoice.voidedAt };
  if (applicable) {
    await invoice.update({ status: 'pending', voidedAt: null, voidReason: null }, { transaction });
    const result = await settlePaid(invoice, args, transaction);
    await recordAudit({
      workspaceId: invoice.workspaceId,
      actorUserId: args.recordedByUserId || null,
      action: 'subscription.plan_move_late_applied',
      entityType: 'BillingInvoice',
      entityId: invoice.id,
      after: { status: 'paid', targetPlanId: invoice.targetPlanId },
      metadata: { wasVoided, source: args.source, externalReference: args.externalReference || null },
      transaction,
    });
    return { ...result, lateMove: 'applied' };
  }

  const amount = Number(args.amountPaid == null ? (args.frozen ? args.frozen.amount : invoice.amount) : args.amountPaid);
  const key = `move_payment_credit:${args.externalReference || `manual:${invoice.id}`}`.slice(0, 120);
  const wallet = require('./walletService');
  // A plan switch's charge in another currency than the balance's is never
  // credited to it: kept on the charge, to refund by hand.
  if (sw && invoice.currency !== wallet.WALLET_CURRENCY) {
    if (invoice.amountPaid == null) {
      await invoice.update(
        {
          amountPaid: amount,
          paidAt: args.paidAt || new Date(),
          ...(args.externalReference ? { externalReference: args.externalReference } : {}),
          paymentNote: `Paid for a plan change that could no longer be applied; not credited (${invoice.currency}): refund by hand.`,
        },
        { transaction }
      );
      await recordAudit({
        workspaceId: invoice.workspaceId,
        actorUserId: args.recordedByUserId || null,
        action: 'subscription.plan_switch_payment_unapplied',
        entityType: 'BillingInvoice',
        entityId: invoice.id,
        after: { status: 'void', amountPaid: amount },
        metadata: { wasVoided, source: args.source, externalReference: args.externalReference || null, currency: invoice.currency, planSwitchId: sw.id },
        transaction,
      });
      logger.error(`billing invoice ${invoice.id}: ${amount} ${invoice.currency} paid for a plan change that could no longer be applied. Refund it by hand.`);
    }
    return { commission: null, codeLapsed: false, lateMove: 'unapplied' };
  }
  const walletRow = await wallet.lockWallet(invoice.workspaceId, transaction);
  let entry = await db.WalletLedgerEntry.findOne({ where: { idempotencyKey: key }, transaction });
  if (!entry && amount > 0) {
    entry = await wallet.writeEntry(
      walletRow,
      {
        type: 'move_payment_credit',
        delta: amount,
        actorUserId: args.recordedByUserId || null,
        note: `Paid for a plan move that could no longer be applied (charge ${invoice.id})`,
        key,
      },
      transaction
    );
    await invoice.update(
      {
        amountPaid: amount,
        paidAt: args.paidAt || new Date(),
        ...(args.externalReference ? { externalReference: args.externalReference } : {}),
        paymentNote: 'Credited to the prepaid balance: the move could no longer be applied.',
      },
      { transaction }
    );
    await recordAudit({
      workspaceId: invoice.workspaceId,
      actorUserId: args.recordedByUserId || null,
      action: 'subscription.plan_move_payment_credited',
      entityType: 'BillingInvoice',
      entityId: invoice.id,
      after: { status: 'void', credited: amount },
      metadata: { wasVoided, ledgerEntryId: entry.id, source: args.source, externalReference: args.externalReference || null, currency: invoice.currency },
      transaction,
    });
  }
  return { commission: null, codeLapsed: false, lateMove: 'credited', ledgerEntryId: entry ? entry.id : null };
}

/**
 * A move's charge was paid: the store is on the new plan from now, for one
 * period of its cycle (the pay-per-order plan's long period is replaced, not
 * extended), active, with no trial. The charge's period is set to match.
 * The prepaid balance is not touched; with no fee on the new plan, no order
 * fee is taken from here on.
 */
async function switchPlanForMove(invoice, subscription, transaction) {
  const start = new Date();
  const end = addBillingPeriod(start, invoice.targetBillingCycle);
  const before = { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status };
  await invoice.update({ periodStart: start, periodEnd: end }, { transaction });
  await subscription.update(
    {
      planId: invoice.targetPlanId,
      billingCycle: invoice.targetBillingCycle,
      status: 'active',
      graceUntil: null,
      trialEndsAt: null,
      cancelAtPeriodEnd: false,
      currentPeriodStart: start,
      currentPeriodEnd: end,
    },
    { transaction }
  );
  await recordAudit({
    workspaceId: invoice.workspaceId,
    actorUserId: invoice.recordedByUserId || null,
    action: 'subscription.plan_move_complete',
    entityType: 'Subscription',
    entityId: subscription.id,
    before,
    after: { planId: invoice.targetPlanId, billingCycle: invoice.targetBillingCycle, status: 'active' },
    metadata: { billingInvoiceId: invoice.id, paymentSource: invoice.paymentSource, currentPeriodEnd: end },
    transaction,
  });
}

/**
 * Records a gateway-reported payment of `invoiceId` (the `invoice.paid`
 * webhook). A failed invoice can still be paid (a retried charge). An
 * already-paid invoice is left alone, so a redelivered event is a no-op.
 */
async function markChargePaid(invoiceId, { paidAt = new Date(), externalReference, amountPaid } = {}) {
  return db.sequelize.transaction(async (transaction) => {
    const invoice = await db.BillingInvoice.findByPk(invoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!invoice) throw new NotFoundError('Billing invoice');
    if (invoice.status === 'paid') {
      const commission = await db.AgentCommission.findOne({
        where: { billingInvoiceId: invoice.id, voidedAt: null },
        transaction,
      });
      return { invoice, commission, alreadyPaid: true, codeLapsed: false };
    }
    const settled = await settlePaid(invoice, { paidAt, externalReference, amountPaid, source: 'gateway' }, transaction);
    return { invoice, ...settled, alreadyPaid: false };
  });
}

/**
 * A platform user recording a payment received outside any gateway (a bank
 * transfer, cash): the amount actually received, which may differ from the
 * amount due, the date it arrived (`paidAt`, default now — it may be in the
 * past, never the future; validation refuses that) and an optional note. The
 * referral code is still judged now, when the payment is recorded: there is
 * no history of a code's active state to judge it as of `paidAt`. Goes through `settlePaid` like the
 * webhook, so the referral code is re-checked and the ledger written the same
 * way. Unlike the webhook it is not idempotent — paying a paid charge again is
 * a 409, because a person doing it twice is a mistake worth telling them
 * about. Audited as a platform-level entry.
 *
 * An online checkout still open for the charge (onlineBillingService) is
 * superseded, so the merchant is no longer offered it. Fawaterak has no way
 * to cancel the link itself: if it is paid anyway, that payment is caught as
 * a duplicate and settles nothing.
 */
async function recordManualPayment(invoiceId, { amountReceived, note, paidAt }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const invoice = await db.BillingInvoice.findByPk(invoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!invoice) throw new NotFoundError('Charge');
    if (invoice.status === 'paid') {
      throw new ConflictError('This charge is already paid.', 'CHARGE_ALREADY_PAID');
    }

    const [onlinePaymentsSuperseded] = await db.BillingPaymentAttempt.update(
      { status: 'superseded' },
      { where: { billingInvoiceId: invoice.id, status: db.BillingPaymentAttempt.IN_PROGRESS }, transaction }
    );
    const before = chargeAuditState(invoice);
    const { commission, codeLapsed } = await settlePaid(
      invoice,
      {
        paidAt: paidAt ? new Date(paidAt) : new Date(),
        amountPaid: amountReceived,
        note: note ? note : null,
        recordedByUserId: req.user.id,
        source: 'manual',
      },
      transaction
    );
    await recordAudit({
      actorUserId: req.user.id,
      action: 'billing_invoice.record_payment',
      entityType: 'BillingInvoice',
      entityId: invoice.id,
      before,
      after: chargeAuditState(invoice),
      metadata: {
        workspaceId: invoice.workspaceId,
        commissionId: commission ? commission.id : null,
        referralCodeLapsed: codeLapsed,
        onlinePaymentsSuperseded,
      },
      req,
      transaction,
    });
    return { invoice, commission, codeLapsed };
  });
}

/**
 * Undoes a payment recorded by hand: the charge goes back to pending, as if
 * the payment had never been recorded, and its commission ledger row is
 * voided (kept, never deleted — see commissionService). Audited with who,
 * when and an optional reason.
 *
 * Refused, with distinct codes, for a charge that isn't paid
 * (CHARGE_NOT_PAID) and for one the gateway confirmed
 * (PAYMENT_CONFIRMED_BY_GATEWAY): that money really moved, and undoing it is
 * a refund, not a correction. Also refused while the subscription has
 * another open charge (OPEN_CHARGE_EXISTS), since only one may be pending.
 *
 * The subscription goes to past_due — the status a failed payment already
 * produces — but only when this payment is what made it active (per the
 * snapshot the payment left on the charge). One that was already active
 * before it (a renewal paid early), or has since moved to another status
 * (past_due for another reason, cancelled), is left alone. Its period fields
 * are not touched, as a failed payment does not touch them either. Paying the
 * reopened charge again makes it active exactly as any payment does.
 */
async function reverseManualPayment(invoiceId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const invoice = await db.BillingInvoice.findByPk(invoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!invoice) throw new NotFoundError('Charge');
    if (invoice.status !== 'paid') {
      throw new ConflictError('This charge is not paid, so there is no payment to reverse.', 'CHARGE_NOT_PAID');
    }
    if (invoice.paymentSource !== 'manual') {
      throw new ConflictError(
        'This payment was confirmed by the payment gateway, so it cannot be reversed here. The money moved; undoing it is a refund.',
        'PAYMENT_CONFIRMED_BY_GATEWAY'
      );
    }
    const otherOpen = await db.BillingInvoice.findOne({
      where: { subscriptionId: invoice.subscriptionId, status: 'pending' },
      attributes: ['id'],
      transaction,
    });
    if (otherOpen) {
      throw new ConflictError(
        'Another charge is open for this subscription. Only one can be pending, so settle that one first.',
        'OPEN_CHARGE_EXISTS'
      );
    }

    const before = { ...chargeAuditState(invoice), recordedByUserId: invoice.recordedByUserId };
    const subscription = await db.Subscription.findByPk(invoice.subscriptionId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const snapshot = invoice.subscriptionBeforePayment;
    const statusBefore = snapshot ? snapshot.status : null;
    // No snapshot (a charge paid before migration 109): an active subscription
    // is taken to have been made active by this payment, the common case.
    const madeActiveByThisPayment = subscription.status === 'active' && statusBefore !== 'active';
    const subscriptionStatus = { from: subscription.status, to: subscription.status };
    // A move's payment undone: the store goes back to the plan and period it
    // had, while it is still on the plan this payment moved it to.
    const undoMove = Boolean(invoice.targetPlanId && snapshot && snapshot.planId && subscription.planId === invoice.targetPlanId);
    if (undoMove) {
      await subscription.update(
        {
          planId: snapshot.planId,
          billingCycle: snapshot.billingCycle,
          status: snapshot.status,
          currentPeriodStart: snapshot.currentPeriodStart,
          currentPeriodEnd: snapshot.currentPeriodEnd,
        },
        { transaction }
      );
      subscriptionStatus.to = snapshot.status;
      subscriptionStatus.planRestored = snapshot.planId;
      // A plan switch this payment applied waits for its charge again.
      const reopened = await planSwitches.reopenAfterReversal(invoice, transaction);
      if (reopened) subscriptionStatus.planSwitchReopened = reopened.id;
    } else if (madeActiveByThisPayment && !invoice.targetPlanId) {
      await subscription.update({ status: 'past_due' }, { transaction });
      subscriptionStatus.to = 'past_due';
    }

    const voided = await commissions.voidForInvoice(invoice.id, { reason }, req, transaction);
    await invoice.update(
      {
        status: 'pending',
        paidAt: null,
        amountPaid: null,
        paymentNote: null,
        recordedByUserId: null,
        paymentSource: null,
        paymentRecordedAt: null,
        subscriptionBeforePayment: null,
      },
      { transaction }
    );
    await recordAudit({
      actorUserId: req.user.id,
      action: 'billing_invoice.reverse_payment',
      entityType: 'BillingInvoice',
      entityId: invoice.id,
      before,
      after: { ...chargeAuditState(invoice), recordedByUserId: null },
      metadata: {
        workspaceId: invoice.workspaceId,
        reason: reason || null,
        voidedCommissionId: voided ? voided.id : null,
        // A commission already paid out to the agent is money to recover.
        voidedCommissionWasPaidOut: voided ? voided.payoutStatus === 'marked_paid' : false,
        subscriptionStatus,
      },
      req,
      transaction,
    });
    logger.info(
      `billing invoice ${invoice.id}: manual payment reversed by ${req.user.id}` +
        (voided ? `, commission row ${voided.id} voided` : '')
    );
    return { invoice, voidedCommission: voided, subscriptionStatus };
  });
}

/**
 * Records a failed payment: a pending invoice becomes failed and the
 * subscription past_due, as the `payment.failed` event already does. A paid
 * invoice is never un-paid by a late failure event.
 */
async function markChargeFailed(invoiceId, { reason } = {}) {
  return db.sequelize.transaction(async (transaction) => {
    const invoice = await db.BillingInvoice.findByPk(invoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!invoice) throw new NotFoundError('Billing invoice');
    if (invoice.status !== 'pending') return { invoice, changed: false };
    // A plan switch's charge never fails the subscription: with
    // PLAN_SWITCH_ENABLED on it is voided and the switch cancelled
    // (planSwitchService.failSwitchCharge); off, it stays payable until the
    // merchant pays again, cancels the switch, or it expires.
    if (await planSwitches.switchOfCharge(invoice, transaction)) {
      // eslint-disable-next-line global-require
      const voided = await require('./planSwitchService').failSwitchCharge(invoice.id, { source: 'invoice.payment_failed' }, transaction);
      return { invoice, changed: voided };
    }

    await invoice.update({ status: 'failed', failureReason: reason ? String(reason).slice(0, 300) : null }, { transaction });
    const subscription = await db.Subscription.findByPk(invoice.subscriptionId, { transaction });
    if (subscription.status !== 'cancelled') await subscription.update({ status: 'past_due' }, { transaction });
    // eslint-disable-next-line global-require
    await require('../platformAdmin/platformNotificationService').paymentFailed(invoice, transaction);
    return { invoice, changed: true };
  });
}

// ------------------------------------------------------------ console view

const CHARGE_INCLUDE = [
  { model: db.ReferralCode, as: 'referralCode', attributes: ['id', 'code'] },
  { model: db.User, as: 'recordedBy', attributes: ['id', 'fullName'] },
  { model: db.AgentCommission, as: 'commission', attributes: ['id', 'suggestedCommission', 'payoutStatus'] },
  {
    model: db.BillingPaymentAttempt,
    as: 'onlinePayments',
    include: [{ model: db.BillingGatewayEvent, as: 'events', where: { kind: 'refund' }, required: false }],
  },
];

/** An online checkout of the charge (onlineBillingService), for the console. */
function serializeOnlinePayment(attempt) {
  return {
    id: attempt.id,
    provider: attempt.provider,
    // created | open | pending | paid | paid_duplicate | mismatch | failed |
    // expired | superseded | error. paid_duplicate is money to refund by
    // hand; mismatch is a payment that settled nothing, to decide on.
    status: attempt.status,
    amount: Number(attempt.amount),
    currency: attempt.currency,
    verifiedAmount: attempt.verifiedAmount == null ? null : Number(attempt.verifiedAmount),
    verifiedCurrency: attempt.verifiedCurrency,
    providerTransactionId: attempt.providerTransactionId == null ? null : Number(attempt.providerTransactionId),
    paymentMethod: attempt.paymentMethod,
    referenceNumber: attempt.referenceNumber,
    failureReason: attempt.failureReason,
    createdAt: attempt.createdAt,
    paidAt: attempt.paidAt,
    expiresAt: attempt.expiresAt,
    // Refunds Fawaterak reported as approved; nothing was changed for them.
    refundsReported: (attempt.events || []).map((e) => ({
      amount: e.payload.amount === undefined ? null : String(e.payload.amount),
      currency: e.payload.currency || null,
      approvedAt: e.payload.approvedAt || null,
      reportedAt: e.createdAt,
    })),
  };
}

function serializeCharge(invoice, payable = null) {
  const online = [...(invoice.onlinePayments || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {
    id: invoice.id,
    status: invoice.status,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    grossAmount: Number(invoice.grossAmount),
    discountAmount: Number(invoice.discountAmount),
    amountDue: Number(invoice.amount),
    amountPaid: invoice.amountPaid == null ? null : Number(invoice.amountPaid),
    currency: invoice.currency,
    referralCode: invoice.referralCode ? { id: invoice.referralCode.id, code: invoice.referralCode.code } : null,
    // When the money arrived: the gateway's time, or the date entered with a
    // manual payment.
    paidAt: invoice.paidAt,
    paymentSource: invoice.paymentSource,
    // When a manual payment was recorded (may be later than paidAt).
    paymentRecordedAt: invoice.paymentRecordedAt,
    failureReason: invoice.failureReason,
    externalReference: invoice.externalReference,
    paymentNote: invoice.paymentNote,
    recordedBy: invoice.recordedBy ? { id: invoice.recordedBy.id, fullName: invoice.recordedBy.fullName } : null,
    // Priced with a special-terms price override.
    specialTermsId: invoice.specialTermsId || null,
    // A pay-per-order store's move: the plan and cycle it switches to when paid.
    targetPlanId: invoice.targetPlanId || null,
    targetBillingCycle: invoice.targetBillingCycle || null,
    // A charge that no longer asks for money: cancelled | replaced | expired |
    // cancelled_by_merchant | voided_by_admin | payment_failed, and the
    // console's reason when it voided it.
    voidedAt: invoice.voidedAt || null,
    voidReason: invoice.voidReason || null,
    voidNote: invoice.voidNote || null,
    commission: invoice.commission
      ? {
          id: invoice.commission.id,
          suggestedCommission: Number(invoice.commission.suggestedCommission),
          payoutStatus: invoice.commission.payoutStatus,
        }
      : null,
    // An unpaid charge, re-priced as it would be if paid now.
    payableNow: payable
      ? {
          discountAmount: payable.discountAmount,
          amountDue: payable.amount,
          referralCodeApplies: Boolean(payable.referralCodeId),
          codeLapsed: payable.codeLapsed,
        }
      : null,
    // Online checkouts, newest first. While one is in progress the merchant
    // may be paying it: recording a payment by hand supersedes it.
    onlinePayments: online.map(serializeOnlinePayment),
    onlinePaymentInProgress: online.some((a) => db.BillingPaymentAttempt.IN_PROGRESS.includes(a.status)),
    createdAt: invoice.createdAt,
  };
}

async function getCharge(invoiceId) {
  const invoice = await db.BillingInvoice.findByPk(invoiceId, { include: CHARGE_INCLUDE });
  if (!invoice) throw new NotFoundError('Charge');
  return { ...serializeCharge(invoice, invoice.status === 'paid' ? null : await payableNow(invoice)), voidable: await voidableByAdmin(invoice) };
}

/**
 * The console's billing view of one workspace: the subscription with its
 * referral code (and agent), a preview of the next charge, and every charge,
 * newest first. Unpaid charges carry what they would come to if paid now.
 */
async function listCharges(workspaceId) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    include: [
      { model: db.Plan, as: 'plan' },
      {
        model: db.ReferralCode,
        as: 'referralCode',
        include: [{ model: db.User, as: 'agent', attributes: ['id', 'fullName'] }],
      },
    ],
  });
  if (!subscription) throw new NotFoundError('Subscription');

  const invoices = await db.BillingInvoice.findAll({
    where: { subscriptionId: subscription.id },
    include: CHARGE_INCLUDE,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'ASC'],
    ],
  });
  // A pay-per-order store's move names the plan it moves to.
  const targetIds = [...new Set(invoices.map((i) => i.targetPlanId).filter(Boolean))];
  const targetNames = new Map(
    targetIds.length ? (await db.Plan.findAll({ where: { id: targetIds }, attributes: ['id', 'name'] })).map((p) => [p.id, p.name]) : []
  );
  // A charge a merchant's plan switch made (an upgrade, or a move from a free
  // plan) says so: it is not a pay-per-order move.
  const switchIds = invoices.filter((i) => i.targetPlanId).map((i) => i.id);
  const switches = new Map(
    switchIds.length
      ? (await db.PlanSwitch.findAll({ where: { billingInvoiceId: switchIds }, attributes: ['id', 'billingInvoiceId', 'kind', 'status', 'fromPlanId'] })).map((s) => [
          s.billingInvoiceId,
          s,
        ])
      : []
  );
  const charges = [];
  for (const invoice of invoices) {
    const row = serializeCharge(invoice, invoice.status === 'paid' ? null : await payableNow(invoice));
    if (invoice.targetPlanId) row.targetPlanName = targetNames.get(invoice.targetPlanId) || null;
    const sw = switches.get(invoice.id);
    if (sw) row.planSwitch = { id: sw.id, kind: sw.kind, status: sw.status, fromPlanId: sw.fromPlanId };
    // Whether the console's Void applies (PLAN_SWITCH_ENABLED, pending, no proof waiting).
    row.voidable = await voidableByAdmin(invoice);
    charges.push(row);
  }

  const plan = subscription.plan;
  const hasPending = invoices.some((i) => i.status === 'pending');
  let nextCharge = null;
  if (plan && !hasPending && !manualPricing.isManuallyPriced(subscription) && planPrice(plan, subscription.billingCycle) > 0) {
    const { referralCodeId, specialTermsId, ...pricing } = await priceCharge(subscription, plan);
    nextCharge = pricing;
  }
  const terms = await specialTerms.listTerms(subscription.id);

  const code = subscription.referralCode;
  return {
    subscription: {
      id: subscription.id,
      status: subscription.status,
      billingCycle: subscription.billingCycle,
      planName: plan ? plan.name : null,
      // One period's price on each cycle (annual = 10 × monthly).
      planPrices: plan
        ? { monthly: planPrice(plan, 'monthly'), yearly: planPrice(plan, 'yearly'), currency: plan.currency }
        : null,
      currentPeriodEnd: subscription.currentPeriodEnd,
      referralCode: code
        ? {
            id: code.id,
            code: code.code,
            active: code.active,
            discountType: code.discountType,
            discountValue: code.discountValue == null ? null : Number(code.discountValue),
            discountCurrency: code.discountCurrency,
            agent: code.agent ? { id: code.agent.id, fullName: code.agent.fullName } : null,
            attachedAt: subscription.referralCodeAttachedAt,
          }
        : null,
    },
    nextCharge,
    charges,
    // Every special-terms grant, newest first; `active` marks those in effect.
    specialTerms: terms,
  };
}

module.exports = {
  addBillingPeriod,
  planPrice,
  priceCharge,
  payableNow,
  createCharge,
  createChargeInTransaction,
  createMoveChargeInTransaction,
  voidMoveCharge,
  voidRenewalCharge,
  voidPendingCharge,
  voidableByAdmin,
  settleLateMovePayment,
  quoteCharge,
  settlePaid,
  markChargePaid,
  recordManualPayment,
  reverseManualPayment,
  markChargeFailed,
  serializeCharge,
  getCharge,
  listCharges,
};
