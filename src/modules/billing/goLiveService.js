'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { planPrice } = require('./planPricing');
const publicPlans = require('./publicPlansService');

/**
 * Taking a draft store live (REQUIRE_SUBSCRIPTION_TO_GO_LIVE). A draft is a
 * store whose subscription status is 'draft' (see
 * workspaces/workspaceAccessService, where that is recognised); it leaves
 * draft the moment anything writes a running status:
 *
 *   start-trial        a free trial, once per account (the store's owner):
 *                      any row in plan_trials for the owner, on any plan,
 *                      means it was used. On the store's plan or another
 *                      offered one (`planId`): trialing from now for that
 *                      plan's trial_days. The trial clock starts here, not
 *                      at sign-up, so no trial day is spent while building.
 *   activate-free-plan a plan that costs nothing on the store's billing
 *                      cycle: active straight away, for FREE_PLAN_YEARS.
 *   manual activation  the console's Activate (billing/manualSubscriptionService)
 *                      or a recorded payment (subscriptionChargeService):
 *                      both already write 'active'.
 *
 * After that the store follows the ordinary lifecycle — the expiry warning,
 * the grace day, the restriction — like any other.
 *
 * Both actions here lock the subscription row, and a repeat of one that
 * already happened (a double click) answers with the result instead of an
 * error, changing nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// A free plan never lapses on its own; the lifecycle only knows periods, so
// its period is simply long.
const FREE_PLAN_YEARS = 100;

/**
 * Whether the account `userId` has had its free trial: any row in
 * plan_trials, on any plan — a trial started here, the trial a store got when
 * it was created with drafts off, or the backfill (migration 126).
 */
async function accountTrialUsed(userId, transaction) {
  return Boolean(await db.PlanTrial.findOne({ where: { userId }, attributes: ['id'], transaction }));
}

/** Whether `userId` may still start a trial of `plan`: { eligible, days, reason? }. */
async function trialEligibility(userId, plan, transaction) {
  const days = plan ? plan.trialDays : 0;
  if (!plan || !(days > 0)) return { eligible: false, days: days || 0, reason: 'no_trial' };
  return (await accountTrialUsed(userId, transaction)) ? { eligible: false, days, reason: 'used' } : { eligible: true, days };
}

/** Serialises trial starts for one account until the transaction ends. */
async function lockAccountTrials(userId, transaction) {
  await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext($key))', { bind: { key: `trial:${userId}` }, transaction });
}

/**
 * Notes that `userId` got `plan`'s trial. Returns false when they already
 * had it (the unique index decides, so two stores racing for one trial get
 * one between them).
 */
async function recordTrial({ userId, planId, workspaceId, source, startedAt }, transaction) {
  const [rows] = await db.sequelize.query(
    `INSERT INTO plan_trials (id, user_id, plan_id, workspace_id, source, started_at, created_at)
     VALUES ($id, $userId, $planId, $workspaceId, $source, $startedAt, NOW())
     ON CONFLICT (user_id, plan_id) DO NOTHING
     RETURNING id`,
    { bind: { id: crypto.randomUUID(), userId, planId, workspaceId, source, startedAt }, transaction }
  );
  return rows.length > 0;
}

/**
 * What a draft store is waiting for, as the dashboard's subscribe screen and
 * every SUBSCRIPTION_REQUIRED refusal describe it: its plan, and whether the
 * owner can still take that plan's trial.
 */
async function draftDetails(workspaceId, { transaction } = {}) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    include: [
      { model: db.Plan, as: 'plan' },
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'ownerUserId'] },
    ],
    transaction,
  });
  const plan = subscription ? subscription.plan : null;
  const trial =
    plan && subscription.workspace
      ? await trialEligibility(subscription.workspace.ownerUserId, plan, transaction)
      : { eligible: false, days: 0 };
  return {
    planId: plan ? plan.id : null,
    planName: plan ? plan.name : null,
    trial: { eligible: trial.eligible, days: trial.days },
    free: plan ? planPrice(plan, subscription.billingCycle) === 0 : false,
  };
}

/** The refusal for anything a draft may not do (publishing, selling, a domain, …). */
async function subscriptionRequiredError(workspaceId) {
  const details = await draftDetails(workspaceId);
  return new AppError(
    'SUBSCRIPTION_REQUIRED',
    'This store is a draft. Subscribe to publish it and take orders.',
    403,
    { draft: true, planId: details.planId, planName: details.planName, trial: details.trial }
  );
}

function subscriptionState(subscription) {
  return {
    status: subscription.status,
    trialEndsAt: subscription.trialEndsAt,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
  };
}

async function lockedDraft(workspaceId, transaction) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!subscription) throw new NotFoundError('Subscription');
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'ownerUserId'], transaction });
  const plan = subscription.planId ? await db.Plan.findByPk(subscription.planId, { transaction }) : null;
  return { subscription, workspace, plan };
}

function notADraft() {
  return new ConflictError('This store is already subscribed', 'NOT_A_DRAFT');
}

/**
 * POST /workspaces/:id/start-trial — from draft only. `planId` (optional) is
 * the plan to try: the store's own, or another one on offer (never a private
 * plan); the store moves to it. Trials of one account are serialised on an
 * advisory lock, so two of its stores (or two plans) racing get one trial
 * between them.
 */
async function startTrial(workspaceId, req, { planId = null } = {}) {
  return db.sequelize.transaction(async (transaction) => {
    const { subscription, workspace, plan: current } = await lockedDraft(workspaceId, transaction);
    if (subscription.status !== 'draft') {
      const own = await db.PlanTrial.findOne({ where: { workspaceId, source: 'start_trial' }, attributes: ['id'], transaction });
      if (own && subscription.status === 'trialing') return { subscription, started: false };
      throw notADraft();
    }
    const plan = planId && (!current || planId !== current.id) ? await publicPlans.findOfferedPlan(planId, transaction) : current;
    if (!plan) throw new ConflictError('This store has no plan to try', 'NO_PLAN');
    await lockAccountTrials(workspace.ownerUserId, transaction);

    const trial = await trialEligibility(workspace.ownerUserId, plan, transaction);
    const refused = (reason) =>
      new AppError('TRIAL_NOT_AVAILABLE', 'The free trial of this plan is not available for this account', 409, {
        reason,
        days: trial.days,
      });
    if (!trial.eligible) throw refused(trial.reason);

    const now = new Date();
    // A code entered on the draft that adds trial days (referrals/redemptionService) gives them now.
    // eslint-disable-next-line global-require
    const extraDays = await require('../referrals/redemptionService').takePendingTrialDays(subscription, transaction);
    const end = new Date(now.getTime() + (trial.days + extraDays) * DAY_MS);
    const recorded = await recordTrial(
      { userId: workspace.ownerUserId, planId: plan.id, workspaceId, source: 'start_trial', startedAt: now },
      transaction
    );
    if (!recorded) throw refused('used');

    const before = { ...subscriptionState(subscription), planId: subscription.planId };
    await subscription.update(
      {
        planId: plan.id,
        status: 'trialing',
        trialEndsAt: end,
        currentPeriodStart: now,
        currentPeriodEnd: end,
        graceUntil: null,
        cancelAtPeriodEnd: false,
      },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'subscription.trial_start',
      entityType: 'Subscription',
      entityId: subscription.id,
      before,
      after: { ...subscriptionState(subscription), planId: plan.id },
      metadata: { planId: plan.id, days: trial.days, ...(extraDays ? { referralDays: extraDays } : {}) },
      req,
      transaction,
    });
    return { subscription, started: true };
  });
}

/** POST /workspaces/:id/activate-free-plan — only for a plan that costs nothing. */
async function activateFreePlan(workspaceId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const { subscription, plan } = await lockedDraft(workspaceId, transaction);
    const free = plan && planPrice(plan, subscription.billingCycle) === 0;
    if (subscription.status !== 'draft') {
      if (free && subscription.status === 'active') return { subscription, started: false };
      throw notADraft();
    }
    if (!plan) throw new ConflictError('This store has no plan', 'NO_PLAN');
    if (!free) throw new ConflictError('This plan is not free: it is activated once its payment is recorded', 'PLAN_NOT_FREE');

    const now = new Date();
    const end = new Date(now);
    end.setUTCFullYear(end.getUTCFullYear() + FREE_PLAN_YEARS);
    const before = subscriptionState(subscription);
    await subscription.update(
      { status: 'active', trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: end, graceUntil: null, cancelAtPeriodEnd: false },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'subscription.free_plan_activate',
      entityType: 'Subscription',
      entityId: subscription.id,
      before,
      after: subscriptionState(subscription),
      metadata: { planId: plan.id },
      req,
      transaction,
    });
    return { subscription, started: true };
  });
}

/**
 * At boot, with REQUIRE_SUBSCRIPTION_TO_GO_LIVE off: every store still in
 * draft from while it was on becomes what it would have been without the
 * flag — trialing, on the trial it was created with (its stored period is
 * exactly that). Done once, in the database, so turning the flag on again
 * later never hides a store that went live in between. Returns the count.
 */
async function releaseDraftsWhenOff() {
  if (env.signup.requireSubscription === true) return 0;
  return db.sequelize.transaction(async (transaction) => {
    const [rows] = await db.sequelize.query(
      `UPDATE subscriptions s
          SET status = 'trialing', trial_ends_at = s.current_period_end, updated_at = NOW()
         FROM workspaces w
        WHERE w.id = s.workspace_id AND s.status = 'draft'
        RETURNING s.id, s.workspace_id, s.plan_id, s.current_period_start, s.current_period_end, w.owner_user_id`,
      { transaction }
    );
    for (const row of rows) {
      if (row.plan_id && row.owner_user_id && new Date(row.current_period_end) > new Date(row.current_period_start)) {
        await recordTrial(
          { userId: row.owner_user_id, planId: row.plan_id, workspaceId: row.workspace_id, source: 'store_created', startedAt: row.current_period_start },
          transaction
        );
      }
      await recordAudit({
        workspaceId: row.workspace_id,
        action: 'subscription.draft_released',
        entityType: 'Subscription',
        entityId: row.id,
        before: { status: 'draft' },
        after: { status: 'trialing', trialEndsAt: row.current_period_end },
        metadata: { reason: 'REQUIRE_SUBSCRIPTION_TO_GO_LIVE is off' },
        transaction,
      });
    }
    return rows.length;
  });
}

/** How to pay by hand, as set in PAYMENT_INSTRUCTIONS_AR / _EN; null when neither is. */
function paymentInstructions() {
  const { ar, en } = env.signup.paymentInstructions;
  return ar || en ? { ar: ar || null, en: en || null } : null;
}

module.exports = {
  FREE_PLAN_YEARS,
  accountTrialUsed,
  trialEligibility,
  recordTrial,
  draftDetails,
  subscriptionRequiredError,
  startTrial,
  activateFreePlan,
  releaseDraftsWhenOff,
  paymentInstructions,
};
