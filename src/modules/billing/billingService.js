'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');

const Op = db.Sequelize.Op;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Subscription state. No payment gateway is connected yet (see
 * gatewaySignature.js) — wiring one in means implementing
 * `verifyGatewaySignature` and adjusting `EVENT_STATUS_MAP`.
 */

// Generic gateway event name -> our Subscription.status. Remapped to a real
// provider's event names when a gateway is chosen.
const EVENT_STATUS_MAP = {
  'subscription.activated': 'active',
  'payment.failed': 'past_due',
  'subscription.canceled': 'cancelled',
  'subscription.cancelled': 'cancelled',
};

const DEFAULT_PLANS = [
  { key: 'free', name: 'Free', monthlyPriceAmount: 0, yearlyPriceAmount: 0, trialDays: 14, softOrderQuota: 50 },
  { key: 'starter', name: 'Starter', monthlyPriceAmount: 29900, yearlyPriceAmount: 299900, trialDays: 14, softOrderQuota: 500 },
  { key: 'growth', name: 'Growth', monthlyPriceAmount: 79900, yearlyPriceAmount: 799900, trialDays: 14, softOrderQuota: 5000 },
];

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
    where: { isActive: true },
    order: [['monthlyPriceAmount', 'ASC']],
    ...(transaction ? { transaction } : {}),
  });
}

/**
 * Called inside the workspace-creation transaction. Creates a `trialing`
 * subscription — no card, no gateway call. Tolerates there being no plans yet
 * (planId stays null, 14-day fallback trial).
 */
async function ensureSubscriptionForWorkspace(workspaceId, transaction) {
  const existing = await db.Subscription.findOne({ where: { workspaceId }, transaction });
  if (existing) return existing;

  const plan = await defaultPlan(transaction);
  const trialDays = plan ? plan.trialDays : 14;
  const now = new Date();
  const end = new Date(now.getTime() + trialDays * DAY_MS);

  return db.Subscription.create(
    {
      workspaceId,
      planId: plan ? plan.id : null,
      billingCycle: 'monthly',
      status: 'trialing',
      trialEndsAt: end,
      currentPeriodStart: now,
      currentPeriodEnd: end,
      externalProvider: null,
      externalSubscriptionId: null,
    },
    { transaction }
  );
}

/** Map a (already signature-verified) gateway webhook event onto a subscription. */
async function applyWebhookEvent(event) {
  const type = event && event.type;
  const targetStatus = EVENT_STATUS_MAP[type];
  if (!targetStatus) return { handled: false, reason: `unmapped event type "${type}"` };

  const data = (event && event.data) || {};
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
 * Flip trialing subscriptions whose trial has lapsed to `past_due`. With no
 * gateway wired in there is nothing to charge, so this just marks them.
 * Callable manually now, on a schedule later.
 */
async function expireStaleTrials(now = new Date()) {
  const [count] = await db.Subscription.update(
    { status: 'past_due' },
    {
      where: {
        status: 'trialing',
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

/** Platform-admin overview: one row per workspace. */
async function listWorkspacesOverview() {
  const workspaces = await db.Workspace.findAll({
    order: [['createdAt', 'ASC']],
    include: [{ model: db.Subscription, as: 'subscription', include: [{ model: db.Plan, as: 'plan' }] }],
  });

  const counts = await db.Order.findAll({
    attributes: ['workspaceId', [db.Sequelize.fn('COUNT', db.Sequelize.col('id')), 'cnt']],
    group: ['workspaceId'],
    raw: true,
  });
  const countMap = Object.fromEntries(counts.map((c) => [c.workspaceId, Number(c.cnt)]));

  return workspaces.map((w) => {
    const sub = w.subscription;
    return {
      workspaceId: w.id,
      workspaceName: w.name,
      plan: sub && sub.plan ? sub.plan.name : sub && sub.planId ? sub.planId : '—',
      status: sub ? sub.status : 'none',
      trialEndsAt: sub ? sub.trialEndsAt : null,
      currentPeriodEnd: sub ? sub.currentPeriodEnd : null,
      orderCount: countMap[w.id] || 0,
    };
  });
}

module.exports = {
  EVENT_STATUS_MAP,
  seedDefaultPlans,
  ensureSubscriptionForWorkspace,
  applyWebhookEvent,
  expireStaleTrials,
  getSubscription,
  listWorkspacesOverview,
};
