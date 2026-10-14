'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const access = require('../workspaces/workspaceAccessService');
const referralCodes = require('../referrals/referralCodeService');
const goLive = require('./goLiveService');
const charges = require('./subscriptionChargeService');
const publicPlans = require('./publicPlansService');
const wallet = require('./walletService');
const { planPrice, BILLING_CYCLES } = require('./planPricing');

/**
 * The merchant's Subscription section (billing.manage): the plans they can
 * pick from, what a referral code would take off them, their charges, and
 * changing plan before anything is paid.
 *
 * Every price comes from here, from the plan rows: the dashboard never sends
 * one. Annual is 10 × monthly (planPricing). A referral code's discount is
 * the one the charge would get (referralCodeService.discountFor): a
 * percentage of any plan, or a fixed amount in the code's own currency.
 */

const { PLAN_ORDER } = publicPlans;

function priced(plan, cycle, code) {
  const gross = planPrice(plan, cycle);
  const discount = referralCodes.discountFor(code, gross, plan.currency);
  return { gross, discount, net: gross - discount };
}

function serializePlan(plan, { code, currentPlanId }) {
  return {
    ...publicPlans.serializePublicPlan(plan),
    isCurrent: plan.id === currentPlanId,
    // A private plan is listed only as the store's current one; it can't be chosen.
    isPublic: Boolean(plan.isPublic && plan.isActive),
    prices: { monthly: priced(plan, 'monthly', code), yearly: priced(plan, 'yearly', code) },
  };
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

/** The plans on offer, plus the store's own when it isn't one of them. */
async function plansFor(subscription, transaction) {
  // The pay-per-order plan has its own card (`payPerOrder` in listPlans).
  const offered = await db.Plan.findAll({ where: { isPublic: true, isActive: true, perOrderFeeAmount: 0 }, order: PLAN_ORDER, transaction });
  if (subscription.planId && !offered.some((p) => p.id === subscription.planId)) {
    const current = await db.Plan.findByPk(subscription.planId, { transaction });
    if (current && !(Number(current.perOrderFeeAmount) > 0)) offered.unshift(current);
  }
  return offered;
}

/**
 * The pay-per-order card: offered while WALLET_ENABLED is on and a
 * pay-per-order plan is public. `current` when the store is on it.
 */
async function payPerOrderFor(subscription) {
  const current = subscription.planId ? await db.Plan.findByPk(subscription.planId, { attributes: ['id', 'name', 'perOrderFeeAmount', 'currency'] }) : null;
  const onIt = Boolean(current && Number(current.perOrderFeeAmount) > 0);
  const plan = wallet.enabled() ? await wallet.offeredFeePlan() : null;
  const shown = plan || (onIt ? current : null);
  return {
    available: Boolean(plan),
    current: onIt,
    plan: shown ? { id: shown.id, name: shown.name, fee: Number(shown.perOrderFeeAmount), currency: shown.currency } : null,
  };
}

/**
 * How the plan may change now:
 *   'immediate' — a draft or a trial (nothing paid yet): POST .../billing/plan;
 *   'support'   — a paid subscription: through Zimos support.
 * Read from the stored status, so a trial that has run out unpaid can still
 * pick the plan it will pay for.
 */
function planChangeMode(subscription) {
  return subscription.status === 'draft' || subscription.status === 'trialing' ? 'immediate' : 'support';
}

/** The store's plan when it is the pay-per-order plan (a fee per order), else null. */
async function payPerOrderPlanOf(subscription, transaction) {
  if (!subscription.planId) return null;
  const plan = await db.Plan.findByPk(subscription.planId, { transaction });
  return plan && Number(plan.perOrderFeeAmount) > 0 ? plan : null;
}

/** What a pending move's charge says: where to, for how much. */
function serializeMove(invoice, plans) {
  if (!invoice || !invoice.targetPlanId) return null;
  const plan = plans.find((p) => p.id === invoice.targetPlanId);
  return {
    invoiceId: invoice.id,
    planId: invoice.targetPlanId,
    planName: plan ? plan.name : null,
    billingCycle: invoice.targetBillingCycle,
    amountDue: Number(invoice.amount),
    currency: invoice.currency,
    createdAt: invoice.createdAt,
  };
}

/**
 * The move off pay per order, for the Plans tab: offered to a store on that
 * plan (null otherwise). Its balance and debt (a debt must be cleared first),
 * and the move waiting for its payment, if any. A move never starts a trial.
 */
async function moveFor(workspaceId, subscription, plans) {
  if (!(await payPerOrderPlanOf(subscription))) return null;
  const [walletRow, pending] = await Promise.all([
    db.WorkspaceWallet.findOne({ where: { workspaceId }, attributes: ['cashBalance'] }),
    db.BillingInvoice.findOne({ where: { subscriptionId: subscription.id, status: 'pending' } }),
  ]);
  const balance = walletRow ? Number(walletRow.cashBalance) : 0;
  const movePlans = pending && pending.targetPlanId && !plans.some((p) => p.id === pending.targetPlanId)
    ? [...plans, await db.Plan.findByPk(pending.targetPlanId, { attributes: ['id', 'name'] })].filter(Boolean)
    : plans;
  return {
    available: true,
    trial: false,
    balance,
    debt: Math.max(0, -balance),
    currency: wallet.WALLET_CURRENCY,
    pending: serializeMove(pending, movePlans),
    // Another charge is open (not a move): it must be settled first.
    otherChargeOpen: Boolean(pending && !pending.targetPlanId),
  };
}

/** GET /workspaces/:id/billing/plans */
async function listPlans(workspaceId) {
  const subscription = await loadSubscription(workspaceId);
  const [workspace, code] = await Promise.all([
    db.Workspace.findByPk(workspaceId, { attributes: ['id', 'ownerUserId'] }),
    subscription.referralCodeId ? db.ReferralCode.findByPk(subscription.referralCodeId) : null,
  ]);
  const usable = code && code.active ? code : null;
  const plans = await plansFor(subscription);
  const draft = access.isDraftSubscription(subscription);
  const trialUsed = await goLive.accountTrialUsed(workspace.ownerUserId);
  return {
    subscription: {
      status: access.billingLifecycle(subscription).status,
      billingCycle: subscription.billingCycle,
      planId: subscription.planId,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
      draft,
    },
    // A trial can start only from a draft (REQUIRE_SUBSCRIPTION_TO_GO_LIVE
    // on) and once per account; each plan says how long its own is.
    trial: { available: draft && !trialUsed, used: trialUsed },
    planChange: planChangeMode(subscription),
    referralCode: code ? referralCodes.serializeCodeForMerchant(code) : null,
    plans: plans.map((plan) => serializePlan(plan, { code: usable, currentPlanId: subscription.planId })),
    payPerOrder: await payPerOrderFor(subscription),
    // A store on pay per order moving to one of `plans` by itself (requestPlanMove).
    move: await moveFor(workspaceId, subscription, plans),
  };
}

/**
 * POST /workspaces/:id/billing/code-preview — what a code would take off each
 * listed plan, before it is attached. 422 REFERRAL_CODE_INVALID for any code
 * that can't be used. Shows the discount, never the agent.
 */
async function previewCode(workspaceId, input) {
  const code = await referralCodes.findUsableCode(input);
  const subscription = await loadSubscription(workspaceId);
  const plans = await plansFor(subscription);
  return {
    code: referralCodes.serializeCodeForMerchant(code),
    plans: plans.map((plan) => ({
      planId: plan.id,
      prices: { monthly: priced(plan, 'monthly', code), yearly: priced(plan, 'yearly', code) },
    })),
  };
}

const MAX_PAGE_SIZE = 50;

/** What a merchant sees of a charge: no agent, commission, internal note or who recorded it. */
function serializeInvoice(invoice) {
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
    paidAt: invoice.paidAt,
    paymentSource: invoice.paymentSource,
    createdAt: invoice.createdAt,
    // A pay-per-order store's move: the plan and cycle it switches to when paid.
    targetPlanId: invoice.targetPlanId || null,
    targetBillingCycle: invoice.targetBillingCycle || null,
    // A move's charge that no longer asks for money: cancelled | replaced | expired.
    voidReason: invoice.voidReason || null,
  };
}

/** GET /workspaces/:id/billing/invoices?page=&pageSize= — newest first. */
async function listInvoices(workspaceId, { page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
  const { rows, count } = await db.BillingInvoice.findAndCountAll({
    where: { workspaceId },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: size,
    offset: (Math.max(1, page) - 1) * size,
  });
  return { invoices: rows.map(serializeInvoice), page: Math.max(1, page), pageSize: size, total: count };
}

/**
 * POST /workspaces/:id/billing/plan — another plan on offer, at once, while
 * nothing is paid (a draft or a trial; a trial keeps its end date). A paid
 * subscription changes plan through support: 409 PLAN_CHANGE_NEEDS_SUPPORT.
 * A private or inactive plan is refused (422 PLAN_NOT_AVAILABLE), and so is a
 * change while a charge is open (409 OPEN_CHARGE_EXISTS), since that charge
 * was priced for the old plan. The subscription row is locked.
 */
async function changePlan(workspaceId, { planId, billingCycle }, req) {
  const result = await db.sequelize.transaction(async (transaction) => {
    const subscription = await loadSubscription(workspaceId, transaction, { lock: true });
    if (planChangeMode(subscription) !== 'immediate') {
      throw new ConflictError(
        'Your plan can be changed through Zimos support while a paid subscription runs. Contact support.',
        'PLAN_CHANGE_NEEDS_SUPPORT'
      );
    }
    const plan = await publicPlans.findOfferedPlan(planId, transaction);
    const cycle = billingCycle && BILLING_CYCLES.includes(billingCycle) ? billingCycle : subscription.billingCycle;
    if (plan.id === subscription.planId && cycle === subscription.billingCycle) return { changed: false };

    const open = await db.BillingInvoice.findOne({
      where: { subscriptionId: subscription.id, status: 'pending' },
      attributes: ['id'],
      transaction,
    });
    if (open) {
      throw new ConflictError('A charge is open for the current plan. Settle it before changing plan.', 'OPEN_CHARGE_EXISTS');
    }

    const before = { planId: subscription.planId, billingCycle: subscription.billingCycle };
    await subscription.update({ planId: plan.id, billingCycle: cycle }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'subscription.plan_change',
      entityType: 'Subscription',
      entityId: subscription.id,
      before,
      after: { planId: plan.id, billingCycle: cycle },
      metadata: { by: 'merchant', status: subscription.status },
      req,
      transaction,
    });
    return { changed: true };
  });
  return { ...result, plans: await listPlans(workspaceId) };
}

/**
 * POST /workspaces/:id/billing/plan-move { planId, billingCycle } — a store
 * on the pay-per-order plan moves to a plan on offer by itself:
 *
 *   - one ordinary charge for that plan and cycle, paid through the usual
 *     ways (online, a transfer's proof, the console); the plan switches only
 *     when it is paid (subscriptionChargeService.settlePaid), never before;
 *   - never a free trial: the account is marked as having had it;
 *   - refused while the balance is below zero (422 WALLET_DEBT_OUTSTANDING:
 *     top up first); the balance itself is never touched;
 *   - the same move asked again while its charge waits gets that charge back
 *     (`created: false`); any other pending charge refuses it (409
 *     OPEN_CHARGE_EXISTS).
 *
 * Any other store keeps today's rules: a paid subscription changes plan
 * through support (409 PLAN_CHANGE_NEEDS_SUPPORT); a draft or a trial uses
 * POST /billing/plan (409 PLAN_MOVE_NOT_AVAILABLE here).
 */
async function requestPlanMove(workspaceId, { planId, billingCycle }, req) {
  const result = await db.sequelize.transaction(async (transaction) => {
    // A pending charge is locked before the subscription, the order a payment takes.
    await lockPendingCharge(workspaceId, transaction);
    const subscription = await loadSubscription(workspaceId, transaction, { lock: true });
    const current = await payPerOrderPlanOf(subscription, transaction);
    if (!current) {
      if (planChangeMode(subscription) === 'support') {
        throw new ConflictError(
          'Your plan can be changed through Zimos support while a paid subscription runs. Contact support.',
          'PLAN_CHANGE_NEEDS_SUPPORT'
        );
      }
      throw new ConflictError('Only a store on pay per order moves to a plan this way. Choose the plan instead.', 'PLAN_MOVE_NOT_AVAILABLE');
    }
    const plan = await publicPlans.findOfferedPlan(planId, transaction);
    const cycle = billingCycle && BILLING_CYCLES.includes(billingCycle) ? billingCycle : 'monthly';

    const open = await db.BillingInvoice.findOne({ where: { subscriptionId: subscription.id, status: 'pending' }, transaction });
    let replaced = null;
    if (open) {
      if (open.targetPlanId === plan.id && open.targetBillingCycle === cycle) return { invoice: open, created: false };
      // Another plan than the move waiting: that move gives way. Any other
      // charge (a renewal) still has to be settled first.
      if (!open.targetPlanId) {
        throw new ConflictError('A charge is open. Pay it, or wait for it to be settled, before asking for another plan.', 'OPEN_CHARGE_EXISTS');
      }
      replaced = open;
    }

    const walletRow = await db.WorkspaceWallet.findOne({ where: { workspaceId }, attributes: ['cashBalance'], transaction });
    const balance = walletRow ? Number(walletRow.cashBalance) : 0;
    if (balance < 0) {
      throw new AppError(
        'WALLET_DEBT_OUTSTANDING',
        'Your Zimos balance is below zero. Top it up to clear what you owe, then move to a monthly plan.',
        422,
        { debt: -balance, currency: wallet.WALLET_CURRENCY }
      );
    }

    // The pay-per-order plan counts as the account's trial: none on the way out.
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'ownerUserId'], transaction });
    if (workspace && workspace.ownerUserId) {
      await goLive.recordTrial(
        { userId: workspace.ownerUserId, planId: current.id, workspaceId, source: 'pay_per_order', startedAt: new Date() },
        transaction
      );
    }

    if (replaced) await charges.voidMoveCharge(replaced, 'replaced', { actorUserId: req.user.id, req }, transaction);
    const invoice = await charges.createMoveChargeInTransaction(subscription, plan, cycle, { req }, transaction);
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'subscription.plan_move_request',
      entityType: 'Subscription',
      entityId: subscription.id,
      before: { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status },
      after: { planId: plan.id, billingCycle: cycle, switchesWhen: 'paid' },
      metadata: { billingInvoiceId: invoice.id, amount: Number(invoice.amount), currency: invoice.currency, balance, replacedInvoiceId: replaced ? replaced.id : null },
      req,
      transaction,
    });
    return { invoice, created: true };
  });
  return { created: result.created, invoice: serializeInvoice(result.invoice), plans: await listPlans(workspaceId) };
}

/** The store's pending charge, locked (none: nothing). Taken before the subscription row. */
async function lockPendingCharge(workspaceId, transaction) {
  const head = await db.BillingInvoice.findOne({ where: { workspaceId, status: 'pending' }, attributes: ['id'], transaction });
  return head ? db.BillingInvoice.findByPk(head.id, { transaction, lock: transaction.LOCK.UPDATE }) : null;
}

/**
 * POST /workspaces/:id/billing/plan-move/cancel — the merchant drops the move
 * waiting for its payment: its charge is void (not due, not owed), the store
 * stays exactly as it is. Nothing waiting: nothing changes (`cancelled: false`).
 */
async function cancelPlanMove(workspaceId, req) {
  const cancelled = await db.sequelize.transaction(async (transaction) => {
    const invoice = await lockPendingCharge(workspaceId, transaction);
    if (!invoice || !invoice.targetPlanId) return false;
    return charges.voidMoveCharge(invoice, 'cancelled', { actorUserId: req.user.id, req }, transaction);
  });
  return { cancelled, plans: await listPlans(workspaceId) };
}

/**
 * The hourly billing job: a move's charge left unpaid WALLET_MOVE_EXPIRY_HOURS
 * (48) is voided as expired, each in its own transaction with the charge
 * locked, so a payment arriving at the same moment either settles it first or
 * finds it void (and is applied or credited). Behind WALLET_ENABLED.
 */
async function expirePendingMoves({ now = new Date(), limit = 200 } = {}) {
  if (!wallet.enabled()) return { expired: 0 };
  const cutoff = new Date(now.getTime() - env.wallet.moveExpiryHours * 60 * 60 * 1000);
  const { Op } = db.Sequelize;
  const stale = await db.BillingInvoice.findAll({
    where: {
      status: 'pending',
      targetPlanId: { [Op.ne]: null },
      createdAt: { [Op.lt]: cutoff },
      // A plan switch's charge expires by its own rule (planSwitchService.expireUnpaid).
      [Op.and]: [db.sequelize.literal('NOT EXISTS (SELECT 1 FROM plan_switches ps WHERE ps.billing_invoice_id = "BillingInvoice"."id")')],
    },
    attributes: ['id'],
    order: [['createdAt', 'ASC']],
    limit,
  });
  let expired = 0;
  for (const { id } of stale) {
    // eslint-disable-next-line no-await-in-loop
    const voided = await db.sequelize.transaction(async (transaction) => {
      const invoice = await db.BillingInvoice.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      return charges.voidMoveCharge(invoice, 'expired', {}, transaction);
    });
    if (voided) expired += 1;
  }
  return { expired };
}

module.exports = {
  listPlans,
  previewCode,
  listInvoices,
  changePlan,
  requestPlanMove,
  cancelPlanMove,
  expirePendingMoves,
  serializeInvoice,
  MAX_PAGE_SIZE,
};
