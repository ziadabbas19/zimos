'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const access = require('../workspaces/workspaceAccessService');
const { addMonths } = require('./planPricing');
const entitlements = require('./entitlementsService');
const manualPricing = require('./manualPricing');
const logger = require('../../core/utils/logger');

/**
 * A platform admin setting a store's subscription by hand
 * (subscriptions.manage) — there is no payment gateway, so a merchant who paid
 * some other way, a partner, a test store:
 *
 *   activate     a plan for a period: from `startsAt` (now by default, may be
 *                in the past) for `duration` { months | days } or until an
 *                explicit `endsAt`;
 *   change_plan  another plan, the period left as it is;
 *   extend       the period by { months | days }, from its end — or from now
 *                when it has already lapsed (a lapsed merchant's gap is not
 *                billed, as with free months);
 *   end_now      the period ends now.
 *
 * A draft store (REQUIRE_SUBSCRIPTION_TO_GO_LIVE, not subscribed yet) leaves
 * draft on activate or extend, which write 'active'; its stored period is a
 * placeholder, so extend counts from now. There is nothing for end_now to
 * end on a draft.
 *
 * Each writes the store's one subscription row — the row the billing
 * lifecycle reads (workspaces/workspaceAccessService.billingLifecycle) — so
 * everything after follows the lifecycle unchanged: the 3-day warning before
 * the end, one day of grace, then the restriction (BILLING_RESTRICTIONS). An
 * active manual period lifts any "expired" banner or restriction, because the
 * status is active and the period runs. end_now starts that lifecycle now.
 *
 * Nothing here creates, changes or settles a charge or an invoice, so no
 * agent commission is ever recorded for it: recording a payment
 * (subscriptionChargeService) stays the only path to a commission. A charge
 * already open is left alone and reported back so the admin can see it.
 *
 * Activate also sets what the period costs (billing/manualPricing): paid
 * (default, the plan's price), free (a gift) or discounted. Extend and change
 * plan keep it as it is.
 *
 * Every action needs a note, keeps its before/after in
 * subscription_manual_changes (source 'manual_admin') and in the audit log,
 * and may carry an Idempotency-Key: the same key again (a double click)
 * returns the first result and changes nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 1826; // five years
const ACTIONS = ['activate', 'change_plan', 'extend', 'end_now'];
// The actions after which a merchant's waiting plan switch is dropped (billing/planSwitchService).
const DROPS_PLAN_SWITCH = ['activate', 'change_plan', 'end_now'];

const addDays = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS);

function endFrom(start, duration) {
  if (duration.months) return addMonths(start, duration.months);
  return addDays(start, duration.days);
}

function assertLength(start, end, field) {
  const days = (end.getTime() - start.getTime()) / DAY_MS;
  if (days < 1 || days > MAX_DAYS) {
    throw new ValidationError([{ field, message: 'The period must be between 1 day and 5 years' }], 'The period must be between 1 day and 5 years');
  }
}

const requestHash = (action, body) =>
  crypto.createHash('sha256').update(`${action}:${JSON.stringify(body || {})}`).digest('hex');

async function loadPlan(planId, transaction) {
  const plan = await db.Plan.findByPk(planId, { transaction });
  if (!plan || !plan.isActive) {
    throw new ValidationError([{ field: 'planId', message: 'No active plan with this id' }], 'No active plan with this id');
  }
  return plan;
}

/** What set the current period: this history, a paid charge, free months, the trial. */
async function periodSource(subscription, transaction) {
  const end = new Date(subscription.currentPeriodEnd).getTime();
  const manual = await db.SubscriptionManualChange.findOne({
    where: { subscriptionId: subscription.id },
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    transaction,
  });
  if (manual && manual.periodEndAfter && new Date(manual.periodEndAfter).getTime() === end) return 'manual_admin';
  if (subscription.status === 'trialing') return 'trial';
  const paid = await db.BillingInvoice.findOne({
    where: { subscriptionId: subscription.id, status: 'paid', periodEnd: new Date(end) },
    attributes: ['id'],
    transaction,
  });
  if (paid) return 'payment';
  const comp = await db.SubscriptionTerm.findOne({
    where: { subscriptionId: subscription.id, kind: 'free_months', endsAt: new Date(end) },
    attributes: ['id'],
    transaction,
  });
  if (comp) return 'special_terms';
  return 'other';
}

function serializeChange(change) {
  return {
    id: change.id,
    action: change.action,
    source: change.source,
    planBefore: change.planBefore ? { id: change.planBefore.id, name: change.planBefore.name } : change.planIdBefore ? { id: change.planIdBefore, name: null } : null,
    planAfter: change.planAfter ? { id: change.planAfter.id, name: change.planAfter.name } : change.planIdAfter ? { id: change.planIdAfter, name: null } : null,
    statusBefore: change.statusBefore,
    statusAfter: change.statusAfter,
    periodStartBefore: change.periodStartBefore,
    periodEndBefore: change.periodEndBefore,
    periodStartAfter: change.periodStartAfter,
    periodEndAfter: change.periodEndAfter,
    note: change.note,
    actor: change.actor ? { id: change.actor.id, fullName: change.actor.fullName } : null,
    createdAt: change.createdAt,
  };
}

const CHANGE_INCLUDE = [
  { model: db.User, as: 'actor', attributes: ['id', 'fullName'] },
  { model: db.Plan, as: 'planBefore', attributes: ['id', 'name'] },
  { model: db.Plan, as: 'planAfter', attributes: ['id', 'name'] },
];

/** GET /admin/workspaces/:id/subscription — the subscription as the lifecycle sees it, and its manual history. */
async function getForAdmin(workspaceId) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    include: [{ model: db.Plan, as: 'plan' }],
  });
  if (!subscription) throw new NotFoundError('Subscription');
  const lifecycle = access.billingLifecycle(subscription, new Date());
  const draft = access.isDraftSubscription(subscription);
  const history = await db.SubscriptionManualChange.findAll({
    where: { workspaceId },
    include: CHANGE_INCLUDE,
    order: [['createdAt', 'DESC'], ['id', 'DESC']],
    limit: 50,
  });
  const openCharge = await db.BillingInvoice.findOne({
    where: { subscriptionId: subscription.id, status: 'pending' },
    attributes: ['id', 'amount', 'currency', 'periodStart', 'periodEnd'],
  });
  return {
    subscription: {
      id: subscription.id,
      plan: subscription.plan ? { id: subscription.plan.id, name: subscription.plan.name, code: subscription.plan.key } : null,
      status: lifecycle.status,
      storedStatus: subscription.status,
      phase: lifecycle.phase,
      billingCycle: subscription.billingCycle,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      restrictsAt: lifecycle.restrictsAt,
      source: draft ? 'draft' : await periodSource(subscription),
      // Made while REQUIRE_SUBSCRIPTION_TO_GO_LIVE was on and not subscribed
      // yet: Activate takes it out of draft.
      draft,
      // billing/manualPricing: what one period costs the merchant.
      pricingKind: subscription.pricingKind,
      discountPercent: subscription.discountPercent,
      priceOverrideAmount: subscription.priceOverrideAmount === null ? null : Number(subscription.priceOverrideAmount),
      effectivePrice: manualPricing.effectivePrice(subscription, subscription.plan),
      currency: subscription.plan ? subscription.plan.currency : null,
      pricingExpiredAt: subscription.pricingExpiredAt,
    },
    // The owner's stores and this store's funnels this month, against the plan.
    limits: await entitlements.getLimits(workspaceId),
    openCharge: openCharge ? openCharge.toJSON() : null,
    history: history.map(serializeChange),
  };
}

const auditState = (subscription) => ({
  planId: subscription.planId,
  status: subscription.status,
  currentPeriodStart: subscription.currentPeriodStart,
  currentPeriodEnd: subscription.currentPeriodEnd,
  pricingKind: subscription.pricingKind,
  discountPercent: subscription.discountPercent,
  priceOverrideAmount: subscription.priceOverrideAmount === null ? null : Number(subscription.priceOverrideAmount),
});

/** The kind and the price of one period as the merchant pays it (minor units), for the audit entry. */
async function pricingSummary(subscription, transaction) {
  const plan = subscription.planId ? await db.Plan.findByPk(subscription.planId, { transaction }) : null;
  return {
    kind: subscription.pricingKind,
    amount: manualPricing.effectivePrice(subscription, plan),
    currency: plan ? plan.currency : null,
  };
}

/**
 * Runs one manual action in a transaction that locks the subscription row:
 * replays an Idempotency-Key it has seen, applies `mutate`, records the change
 * and the audit entry. Returns { change, replayed }.
 */
async function runAction(workspaceId, action, body, req, mutate) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown action ${action}`);
  const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].trim().slice(0, 200) : null;
  const hash = requestHash(action, body);

  const result = await db.sequelize.transaction(async (transaction) => {
    const subscription = await db.Subscription.findOne({ where: { workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!subscription) throw new NotFoundError('Subscription');

    if (key) {
      const earlier = await db.SubscriptionManualChange.findOne({ where: { workspaceId, idempotencyKey: key }, transaction });
      if (earlier) {
        if (earlier.requestHash !== hash) {
          throw new ConflictError('This Idempotency-Key was already used for a different request', 'IDEMPOTENCY_KEY_REUSED');
        }
        return { changeId: earlier.id, replayed: true };
      }
    }

    const before = auditState(subscription);
    const patch = await mutate(subscription, transaction);
    await subscription.update(patch, { transaction });
    // A plan switch the merchant left waiting no longer fits a period or a
    // plan set here: dropped, its charge voided. Extending keeps it.
    if (DROPS_PLAN_SWITCH.includes(action)) {
      // eslint-disable-next-line global-require
      await require('./planSwitchService').dropOpen(subscription, `admin_${action}`, { actorUserId: req.user.id, req }, transaction);
    }

    const change = await db.SubscriptionManualChange.create(
      {
        workspaceId,
        subscriptionId: subscription.id,
        action,
        source: 'manual_admin',
        planIdBefore: before.planId,
        planIdAfter: subscription.planId,
        statusBefore: before.status,
        statusAfter: subscription.status,
        periodStartBefore: before.currentPeriodStart,
        periodEndBefore: before.currentPeriodEnd,
        periodStartAfter: subscription.currentPeriodStart,
        periodEndAfter: subscription.currentPeriodEnd,
        note: body.note,
        actorUserId: req.user.id,
        idempotencyKey: key,
        requestHash: key ? hash : null,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: `subscription.manual_${action}`,
      entityType: 'Subscription',
      entityId: subscription.id,
      before,
      after: auditState(subscription),
      metadata: { source: 'manual_admin', note: body.note, changeId: change.id, pricing: await pricingSummary(subscription, transaction) },
      req,
      transaction,
    });
    return { changeId: change.id, replayed: false };
  });

  const change = await db.SubscriptionManualChange.findByPk(result.changeId, { include: CHANGE_INCLUDE });
  return { change: serializeChange(change), replayed: result.replayed };
}

/** Covered and active from here on: whatever unpaid state the row was in is over. */
const ACTIVE = { status: 'active', graceUntil: null, cancelAtPeriodEnd: false };

async function activate(workspaceId, body, req) {
  return runAction(workspaceId, 'activate', body, req, async (subscription, transaction) => {
    const plan = await loadPlan(body.planId, transaction);
    const now = new Date();
    const start = body.startsAt ? new Date(body.startsAt) : now;
    if (start.getTime() > now.getTime() + 60 * 1000) {
      throw new ValidationError([{ field: 'startsAt', message: 'The start cannot be in the future' }], 'The start cannot be in the future');
    }
    const end = body.endsAt ? new Date(body.endsAt) : endFrom(start, body.duration);
    assertLength(start, end, body.endsAt ? 'endsAt' : 'duration');
    if (end.getTime() <= now.getTime()) {
      throw new ValidationError([{ field: 'endsAt', message: 'The period must end in the future' }], 'The period must end in the future');
    }
    const cycle = body.billingCycle || subscription.billingCycle;
    return {
      ...ACTIVE,
      planId: plan.id,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      ...(body.billingCycle ? { billingCycle: body.billingCycle } : {}),
      ...manualPricing.pricingPatch(body, plan, cycle, req.user.id),
    };
  });
}

async function changePlan(workspaceId, body, req) {
  return runAction(workspaceId, 'change_plan', body, req, async (subscription, transaction) => {
    const plan = await loadPlan(body.planId, transaction);
    if (subscription.planId === plan.id) throw new ConflictError('The store is already on this plan', 'SAME_PLAN');
    return { planId: plan.id };
  });
}

async function extend(workspaceId, body, req) {
  return runAction(workspaceId, 'extend', body, req, async (subscription) => {
    const now = new Date();
    const draft = subscription.status === 'draft';
    const from = draft ? now : new Date(Math.max(new Date(subscription.currentPeriodEnd).getTime(), now.getTime()));
    const end = endFrom(from, body.duration);
    assertLength(from, end, 'duration');
    if ((end.getTime() - now.getTime()) / DAY_MS > MAX_DAYS) {
      throw new ValidationError([{ field: 'duration', message: 'A subscription cannot run more than 5 years ahead' }], 'A subscription cannot run more than 5 years ahead');
    }
    const lapsed = draft || new Date(subscription.currentPeriodEnd).getTime() < now.getTime();
    return {
      ...(subscription.status === 'trialing' ? { graceUntil: null } : ACTIVE),
      ...(lapsed ? { currentPeriodStart: now } : {}),
      currentPeriodEnd: end,
      // A free or discounted period that had run out runs again, at its price.
      pricingExpiredAt: null,
    };
  });
}

async function endNow(workspaceId, body, req) {
  return runAction(workspaceId, 'end_now', body, req, async (subscription) => {
    const now = new Date();
    if (subscription.status === 'draft') {
      throw new AppError('SUBSCRIPTION_IS_DRAFT', 'This store has not been subscribed yet, so there is no period to end', 409);
    }
    if (new Date(subscription.currentPeriodEnd).getTime() <= now.getTime()) {
      throw new AppError('SUBSCRIPTION_ALREADY_ENDED', 'This subscription period has already ended', 409);
    }
    // The lifecycle takes it from here: past due now, restricted after the grace day.
    return { currentPeriodEnd: now, cancelAtPeriodEnd: false };
  });
}

/**
 * A free or discounted period that ran out does not renew at the plan's price
 * and does not stay active: it moves to past_due (the lifecycle takes it from
 * there, as for any lapsed period), keeps its pricing as a record, and is
 * audited as subscription.manual_pricing_expired so the console hears of it
 * (platformNotifications). Run by the billing.manual_pricing_sweep schedule;
 * each row in its own transaction, a failure logged and never thrown.
 */
async function expireManualPricing(now = new Date()) {
  const { Op } = db.Sequelize;
  const due = await db.Subscription.findAll({
    where: {
      pricingKind: { [Op.in]: ['free', 'discounted'] },
      pricingExpiredAt: null,
      status: { [Op.in]: ['active', 'trialing'] },
      currentPeriodEnd: { [Op.lte]: now },
    },
    attributes: ['id'],
    limit: 500,
  });
  let expired = 0;
  for (const { id } of due) {
    try {
      await db.sequelize.transaction(async (transaction) => {
        const subscription = await db.Subscription.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!subscription || subscription.pricingExpiredAt || subscription.pricingKind === 'paid') return;
        if (new Date(subscription.currentPeriodEnd).getTime() > now.getTime()) return;
        const before = auditState(subscription);
        await subscription.update({ status: 'past_due', pricingExpiredAt: now, cancelAtPeriodEnd: false }, { transaction });
        await recordAudit({
          workspaceId: subscription.workspaceId,
          action: 'subscription.manual_pricing_expired',
          entityType: 'Subscription',
          entityId: subscription.id,
          before,
          after: auditState(subscription),
          metadata: { source: 'manual_admin', pricing: await pricingSummary(subscription, transaction) },
          transaction,
        });
        expired += 1;
      });
    } catch (err) {
      logger.error(`[billing] manual pricing expiry failed for subscription ${id}: ${err.message}`);
    }
  }
  return { expired };
}

module.exports = { getForAdmin, activate, changePlan, extend, endNow, expireManualPricing, periodSource, MAX_DAYS };
