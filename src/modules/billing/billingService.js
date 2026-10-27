'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const referralCodes = require('../referrals/referralCodeService');
const charges = require('./subscriptionChargeService');
const { yearlyPriceFor, planPrice } = require('./planPricing');
const env = require('../../config/env');
const access = require('../workspaces/workspaceAccessService');
const goLive = require('./goLiveService');
const entitlements = require('./entitlementsService');
const onlineBilling = require('./onlineBillingService');
const primaryHost = require('../domains/primaryHost');

const { availableFeatureKeys, isAvailableFeature } = require('./featureCatalog');

const Op = db.Sequelize.Op;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Subscription state. No payment gateway is connected yet — webhook bodies are
 * already authenticated (gatewaySignature.js, HMAC-SHA256 over the raw body),
 * so wiring a provider in means adapting that check to its header/encoding and
 * remapping `EVENT_STATUS_MAP` and `INVOICE_EVENTS` to its event names.
 */

// Generic gateway event name -> our Subscription.status. Remapped to a real
// provider's event names when a gateway is chosen.
const EVENT_STATUS_MAP = {
  'subscription.activated': 'active',
  'payment.failed': 'past_due',
  'subscription.canceled': 'cancelled',
  'subscription.cancelled': 'cancelled',
};

// Generic gateway events about one charge, identified by `data.invoiceId`
// (the billing invoice id the charge was created with, see
// subscriptionChargeService). `amountPaid` (minor units) is what the gateway
// actually took; without it the charge counts as paid in full. Remapped like
// EVENT_STATUS_MAP.
const INVOICE_EVENTS = {
  'invoice.paid': (data) =>
    charges.markChargePaid(data.invoiceId, {
      paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
      externalReference: data.externalReference,
      amountPaid: data.amountPaid == null ? undefined : data.amountPaid,
    }),
  'invoice.payment_failed': (data) => charges.markChargeFailed(data.invoiceId, { reason: data.reason }),
};

async function applyInvoiceEvent(type, data) {
  if (!data.invoiceId || !UUID_PATTERN.test(String(data.invoiceId))) {
    return { handled: false, reason: 'event data has no valid invoiceId' };
  }
  if (data.paidAt && Number.isNaN(new Date(data.paidAt).getTime())) {
    return { handled: false, reason: 'event data has an invalid paidAt' };
  }
  if (data.amountPaid != null && !(Number.isInteger(data.amountPaid) && data.amountPaid >= 0)) {
    return { handled: false, reason: 'event data has an invalid amountPaid' };
  }
  try {
    const result = await INVOICE_EVENTS[type](data);
    logger.info(`billing webhook ${type}: invoice ${data.invoiceId} -> ${result.invoice.status}`);
    return {
      handled: true,
      invoiceId: result.invoice.id,
      status: result.invoice.status,
      commissionId: result.commission ? result.commission.id : undefined,
    };
  } catch (err) {
    if (err instanceof NotFoundError) return { handled: false, reason: 'invoice not found' };
    throw err;
  }
}

const DEFAULT_PLANS = [
  { key: 'free', name: 'Free', monthlyPriceAmount: 0, trialDays: 14, softOrderQuota: 50 },
  { key: 'starter', name: 'Starter', monthlyPriceAmount: 29900, trialDays: 14, softOrderQuota: 500 },
  { key: 'growth', name: 'Growth', monthlyPriceAmount: 79900, trialDays: 14, softOrderQuota: 5000 },
  // The annual price is always derived (billing/planPricing).
].map((p) => ({ ...p, yearlyPriceAmount: yearlyPriceFor(p.monthlyPriceAmount) }));

/**
 * The catalogue keys a plan lists whose feature exists today (anything else in
 * plans.features is dropped from what the merchant sees, not from the row).
 */
function publicFeatureKeys(features) {
  return availableFeatureKeys(features);
}

/** Idempotently create the default plan set. Safe to call repeatedly. */
async function seedDefaultPlans() {
  for (const p of DEFAULT_PLANS) {
    await db.Plan.findOrCreate({ where: { key: p.key }, defaults: { ...p, currency: 'USD', isActive: true } });
  }
  return db.Plan.findAll({ order: [['monthlyPriceAmount', 'ASC']] });
}

/** The plan a brand-new workspace starts its trial on: cheapest active plan. */
async function defaultPlan(transaction) {
  return db.Plan.findOne({
    // Never the pay-per-order plan (no monthly price, a fee per order).
    where: { isActive: true, perOrderFeeAmount: 0 },
    order: [['monthlyPriceAmount', 'ASC']],
    ...(transaction ? { transaction } : {}),
  });
}

/**
 * Called inside the workspace-creation transaction. `plan` is the plan chosen
 * for the store (workspaceService works it out); without one it is the
 * cheapest active plan, as before plans could be chosen. Tolerates there
 * being no plans yet (planId stays null, 14-day fallback trial).
 *
 * Flag off (REQUIRE_SUBSCRIPTION_TO_GO_LIVE): a `trialing` subscription from
 * now, as always — no card, no gateway call. The trial is noted against the
 * owner (plan_trials), which only matters if the flag is turned on later.
 *
 * Flag on: a `draft`. It can be built but not published until a trial or a
 * paid subscription starts (billing/goLiveService). Its period is a
 * placeholder the draft never reads: the trial the store would have had
 * without the flag, so that turning the flag off again leaves it exactly as
 * it would have been (workspaceAccessService reads a draft as trialing then).
 */
async function ensureSubscriptionForWorkspace(workspaceId, transaction, { plan: chosenPlan, billingCycle = 'monthly', ownerUserId } = {}) {
  const existing = await db.Subscription.findOne({ where: { workspaceId }, transaction });
  if (existing) return existing;

  const plan = chosenPlan || (await defaultPlan(transaction));
  const trialDays = plan ? plan.trialDays : 14;
  const now = new Date();
  const end = new Date(now.getTime() + trialDays * DAY_MS);
  const draft = env.signup.requireSubscription === true;

  const subscription = await db.Subscription.create(
    {
      workspaceId,
      planId: plan ? plan.id : null,
      billingCycle,
      status: draft ? 'draft' : 'trialing',
      trialEndsAt: draft ? null : end,
      currentPeriodStart: now,
      currentPeriodEnd: end,
      externalProvider: null,
      externalSubscriptionId: null,
    },
    { transaction }
  );
  if (!draft && plan && trialDays > 0 && ownerUserId) {
    await goLive.recordTrial({ userId: ownerUserId, planId: plan.id, workspaceId, source: 'store_created', startedAt: now }, transaction);
  }
  return subscription;
}

/** Map a (already signature-verified) gateway webhook event onto a subscription. */
async function applyWebhookEvent(event) {
  const type = event && event.type;
  const data = (event && event.data) || {};
  if (Object.prototype.hasOwnProperty.call(INVOICE_EVENTS, type)) return applyInvoiceEvent(type, data);

  const targetStatus = EVENT_STATUS_MAP[type];
  if (!targetStatus) return { handled: false, reason: `unmapped event type "${type}"` };

  let where = null;
  if (data.externalSubscriptionId) where = { externalSubscriptionId: data.externalSubscriptionId };
  else if (data.workspaceId) where = { workspaceId: data.workspaceId };
  if (!where) return { handled: false, reason: 'event data has no workspaceId or externalSubscriptionId' };

  const sub = await db.Subscription.findOne({ where });
  if (!sub) return { handled: false, reason: 'subscription not found' };

  const before = sub.status;
  await sub.update({ status: targetStatus });
  logger.info(`billing webhook ${type}: subscription ${sub.id} ${before} -> ${targetStatus}`);
  return { handled: true, subscriptionId: sub.id, from: before, status: targetStatus };
}

/**
 * Flip trialing and active subscriptions whose period has ended unpaid to
 * `past_due`. With no gateway wired in there is nothing to charge, so this
 * just marks them. Callable manually now (POST /billing/run-trial-check), on
 * a schedule later.
 *
 * Nothing depends on it running: workspaceAccessService already counts a
 * lapsed period as past_due when it works out the expiry banners and the
 * restriction. This only brings the stored status in line, for the lists and
 * counts that read it.
 */
async function expireStaleTrials(now = new Date()) {
  const [count] = await db.Subscription.update(
    { status: 'past_due' },
    {
      where: {
        status: ['trialing', 'active'],
        currentPeriodEnd: { [Op.lt]: now },
        externalSubscriptionId: { [Op.is]: null }, // no real paid subscription behind it
      },
    }
  );
  return { expired: count };
}

async function getSubscription(workspaceId) {
  return db.Subscription.findOne({ where: { workspaceId }, include: [{ model: db.Plan, as: 'plan' }] });
}

// ------------------------------------------------------------ referral code

/**
 * Attaches the referral code a merchant typed to their subscription. It stays
 * attached for the life of the subscription and prices every charge (see
 * subscriptionChargeService). One code per subscription: the same code again
 * is a no-op (`attached: false`), a different one is refused, so a merchant
 * cannot move between agents or shop for a bigger discount.
 *
 * Audited in the workspace. The agent is not named there, because the
 * merchant can read their own audit log.
 */
async function attachReferralCodeInTransaction(workspaceId, input, req, transaction) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!subscription) throw new NotFoundError('Subscription');

  const code = await referralCodes.findUsableCode(input, transaction);
  if (subscription.referralCodeId === code.id) return { subscription, code, attached: false };
  if (subscription.referralCodeId) {
    throw new ConflictError('This workspace already has a referral code.', 'REFERRAL_CODE_ALREADY_SET');
  }

  await subscription.update({ referralCodeId: code.id, referralCodeAttachedAt: new Date() }, { transaction });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'subscription.referral_code_attach',
    entityType: 'Subscription',
    entityId: subscription.id,
    before: { referralCode: null },
    after: { referralCode: code.code },
    req,
    transaction,
  });
  return { subscription, code, attached: true };
}

/**
 * Switches the subscription between monthly and annual billing. It takes
 * effect from the next charge — the current period is not re-dated or
 * re-priced — so it is refused while a charge is open (OPEN_CHARGE_EXISTS):
 * that charge was priced for the old cycle.
 *
 * `platform` is a platform admin acting from the console: audited as a
 * platform-level entry. Otherwise it is the merchant, audited in the
 * workspace.
 */
async function setBillingCycle(workspaceId, billingCycle, req, { platform = false } = {}) {
  return db.sequelize.transaction(async (transaction) => {
    const subscription = await db.Subscription.findOne({
      where: { workspaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!subscription) throw new NotFoundError('Subscription');
    if (subscription.billingCycle === billingCycle) return { subscription, changed: false };

    const open = await db.BillingInvoice.findOne({
      where: { subscriptionId: subscription.id, status: 'pending' },
      attributes: ['id'],
      transaction,
    });
    if (open) {
      throw new ConflictError(
        'A charge is open for this subscription at the current billing cycle. Settle it before switching.',
        'OPEN_CHARGE_EXISTS'
      );
    }
    // A plan switch waiting (billing/planSwitchService) sets the cycle at its
    // moment: the merchant cancels it or picks the cycle with the plan; the
    // console's change drops it.
    const waiting = await db.PlanSwitch.findOne({ where: { subscriptionId: subscription.id, status: ['pending', 'scheduled'] }, attributes: ['id'], transaction });
    if (waiting) {
      if (!platform) {
        throw new ConflictError('A plan change is waiting. Cancel it, or choose the cycle with the plan, before changing the billing cycle.', 'PLAN_SWITCH_WAITING');
      }
      // eslint-disable-next-line global-require
      await require('./planSwitchService').dropOpen(subscription, 'admin_billing_cycle', { actorUserId: req.user.id, req }, transaction);
    }

    const before = subscription.billingCycle;
    await subscription.update({ billingCycle }, { transaction });
    await recordAudit({
      workspaceId: platform ? null : workspaceId,
      actorUserId: req.user.id,
      action: 'subscription.billing_cycle_change',
      entityType: 'Subscription',
      entityId: subscription.id,
      before: { billingCycle: before },
      after: { billingCycle },
      metadata: platform ? { workspaceId } : null,
      req,
      transaction,
    });
    return { subscription, changed: true };
  });
}

async function attachReferralCode(workspaceId, input, req) {
  const { attached } = await db.sequelize.transaction((transaction) =>
    attachReferralCodeInTransaction(workspaceId, input, req, transaction)
  );
  return { billing: await getWorkspaceBilling(workspaceId), attached };
}

/**
 * The merchant's billing summary: plan and status, the attached referral
 * code (the discount only — never the agent or the code's label), a preview
 * of the next charge priced by the same function as the real one, the plan's
 * limits and what the store has used of them, and — for a draft — what it
 * takes to go live (the trial, how to pay by hand).
 */
async function getWorkspaceBilling(workspaceId) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    include: [
      { model: db.Plan, as: 'plan' },
      { model: db.ReferralCode, as: 'referralCode' },
    ],
  });
  if (!subscription) throw new NotFoundError('Subscription');
  const plan = subscription.plan;

  let nextCharge = null;
  if (plan && planPrice(plan, subscription.billingCycle) > 0) {
    const { referralCodeId, specialTermsId, ...pricing } = await charges.priceCharge(subscription, plan);
    nextCharge = pricing;
  }

  const draft = access.isDraftSubscription(subscription);
  const details = draft ? await goLive.draftDetails(workspaceId) : null;

  return {
    subscription: {
      status: subscription.status,
      billingCycle: subscription.billingCycle,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      plan: plan
        ? {
            id: plan.id,
            name: plan.name,
            currency: plan.currency,
            monthlyPrice: planPrice(plan, 'monthly'),
            yearlyPrice: planPrice(plan, 'yearly'),
            trialDays: plan.trialDays,
            maxStores: plan.maxStores,
            maxFunnelsPerMonth: plan.maxFunnelsPerMonth,
            softOrderQuota: plan.softOrderQuota,
            features: publicFeatureKeys(plan.features),
          }
        : null,
    },
    referralCode: subscription.referralCode
      ? {
          ...referralCodes.serializeCodeForMerchant(subscription.referralCode),
          attachedAt: subscription.referralCodeAttachedAt,
        }
      : null,
    nextCharge,
    // The store's features: its plan's, with any override a platform admin
    // set for it (billing/entitlementsService — the one place they are worked
    // out), shown only for features that exist today, like the plan's own list.
    features: (await entitlements.effectiveFeatures(workspaceId)).filter(isAvailableFeature),
    trialEndsAt: subscription.trialEndsAt,
    limits: await entitlements.getLimits(workspaceId),
    draft,
    // Whether the Pay button can be offered (ONLINE_BILLING_ENABLED, an EGP
    // plan), and the latest online payment, whatever its state.
    onlinePayment: await onlineBilling.onlinePaymentSummary(workspaceId, plan),
    // Only while a draft: its trial, and how to pay by hand.
    goLive: draft
      ? {
          trial: details.trial,
          free: details.free,
          paymentInstructions: goLive.paymentInstructions(),
        }
      : null,
  };
}

/** Platform-admin overview: one row per workspace. */
async function listWorkspacesOverview() {
  const workspaces = await db.Workspace.findAll({
    order: [['createdAt', 'ASC']],
    include: [
      { model: db.Subscription, as: 'subscription', include: [{ model: db.Plan, as: 'plan' }] },
      // Who owns it, so the console's store list can be searched by person too.
      { model: db.User, as: 'owner', attributes: ['id', 'username', 'fullName', 'email'] },
    ],
  });

  const counts = await db.Order.findAll({
    attributes: ['workspaceId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'cnt']],
    group: ['workspaceId'],
    raw: true,
  });
  const countMap = Object.fromEntries(counts.map((c) => [c.workspaceId, Number(c.cnt)]));
  // The link that opens each store, every primary domain in one query.
  const origins = await primaryHost.storeOriginsOf(workspaces);

  const now = new Date();
  return workspaces.map((w) => {
    const sub = w.subscription;
    const lifecycle = access.billingLifecycle(sub, now);
    return {
      // Plain workspace entity fields, named as the API names them everywhere
      // else, so an admin client can treat a row as a Workspace.
      id: w.id,
      name: w.name,
      slug: w.slug,
      status: w.status,
      defaultCurrency: w.defaultCurrency,
      createdAt: w.createdAt,
      // The primary domain when it can be served, else the platform subdomain (domains/primaryHost).
      storeUrl: origins.get(w.id) || null,
      // Billing overview, flattened onto the same row.
      plan: sub && sub.plan ? sub.plan.name : sub && sub.planId ? sub.planId : '—',
      planId: sub ? sub.planId : null,
      billingCycle: sub ? sub.billingCycle : null,
      subscriptionStatus: sub ? sub.status : 'none',
      trialEndsAt: sub ? sub.trialEndsAt : null,
      currentPeriodEnd: sub ? sub.currentPeriodEnd : null,
      orderCount: countMap[w.id] || 0,
      // Store access (workspaces/workspaceAccessService): a manual suspension
      // and the billing lifecycle are separate, and either restricts.
      suspended: w.status === 'suspended',
      suspendedAt: w.suspendedAt,
      billingPhase: lifecycle.phase,
      // Made while REQUIRE_SUBSCRIPTION_TO_GO_LIVE was on and not subscribed yet.
      draft: access.isDraftSubscription(sub),
      restricted: w.status === 'suspended' || (lifecycle.restricted && env.billing.restrictions === 'enforce'),
      owner: w.owner
        ? { id: w.owner.id, username: w.owner.username, fullName: w.owner.fullName, email: w.owner.email }
        : null,
      // Legacy aliases — the EJS dashboard at /admin/dashboard reads these.
      workspaceId: w.id,
      workspaceName: w.name,
    };
  });
}

module.exports = {
  publicFeatureKeys,
  defaultPlan,
  EVENT_STATUS_MAP,
  INVOICE_EVENTS,
  seedDefaultPlans,
  ensureSubscriptionForWorkspace,
  applyWebhookEvent,
  expireStaleTrials,
  getSubscription,
  attachReferralCode,
  attachReferralCodeInTransaction,
  setBillingCycle,
  getWorkspaceBilling,
  listWorkspacesOverview,
};
