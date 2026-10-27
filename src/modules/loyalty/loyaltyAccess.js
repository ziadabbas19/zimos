'use strict';

const { QueryTypes } = require('sequelize');
const env = require('../../config/env');
const db = require('../../db/models');
const entitlements = require('../billing/entitlementsService');

/*
 * Whether a store may run its loyalty programme now, and the guard's checks
 * on a customer. Frozen points are kept and shown (balance, history, worth)
 * but never earned, spent or expired; nothing stored changes, so they count
 * again the moment the store has the programme back. A refund or a cancel
 * still gives back points already spent, and still takes back points an
 * order earned.
 *
 * A store is frozen when
 *  - 'plan': LOYALTY_REQUIRE_PLAN_FEATURE and PLAN_FEATURE_ENFORCEMENT are
 *    both on and the store's features (its plan plus the console's
 *    overrides, entitlementsService) lack `loyalty`. A trialing store has the
 *    features of the plan it trials: the console decides, not this code.
 *  - 'subscription': LOYALTY_GUARD_ENABLED is on and the subscription is
 *    unpaid past its grace day (workspaceAccessService.billingLifecycle
 *    'restricted', the rule orders/orderLock.js calls "lapsed"). A store that
 *    pays per order (WALLET_ENABLED and a fee plan) is never frozen for this.
 * Both off (the default): never frozen, and nothing is read.
 */

const FEATURE = 'loyalty';
const DEVICE_WINDOW_HOURS = 24;

const planGateOn = () => env.loyalty.requirePlanFeature === true && env.planFeatures.enforcement === true;
const guardOn = () => env.loyalty.guard === true;

/** True while switching the programme on would be refused (403 PLAN_FEATURE_REQUIRED). */
async function planLocked(workspaceId, { transaction } = {}) {
  if (!planGateOn()) return false;
  return !(await entitlements.hasFeature(workspaceId, FEATURE, { transaction }));
}

async function subscriptionStopped(workspaceId, { transaction, now = new Date() } = {}) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    attributes: ['id', 'status', 'planId', 'currentPeriodEnd'],
    transaction,
  });
  if (!subscription) return false;
  const wallet = require('../billing/walletService');
  if (wallet.enabled() && (await wallet.termsForSubscription(subscription, transaction))) return false;
  const { billingLifecycle } = require('../workspaces/workspaceAccessService');
  return billingLifecycle(subscription, now).phase === 'restricted';
}

/** 'plan' | 'subscription' while the store's points are frozen, else null. */
async function frozenReason(workspaceId, opts = {}) {
  if (await planLocked(workspaceId, opts)) return 'plan';
  if (guardOn() && (await subscriptionStopped(workspaceId, opts))) return 'subscription';
  return null;
}

/** With the guard on: a customer the store blocked (customers.is_blacklisted, fraud/blockedEntries) gets no points and spends none. */
function customerBlocked(customer) {
  return guardOn() && Boolean(customer && customer.isBlacklisted);
}

/**
 * With the guard on: true when the checkout's device (risk/botProtection's
 * deviceId) spent another customer's points in this store in the last 24
 * hours: one person spending the points of several accounts. A shared phone
 * waits a day. No device id, no check.
 */
async function deviceSpentForOther(workspaceId, customerId, deviceId) {
  if (!guardOn() || !deviceId) return false;
  const rows = await db.sequelize.query(
    `SELECT 1 FROM orders o
       JOIN loyalty_transactions lt ON lt.order_id = o.id AND lt.kind = 'redeem'
      WHERE o.workspace_id = :workspaceId AND o.device_id = :deviceId
        AND o.created_at > NOW() - (:hours * INTERVAL '1 hour')
        AND lt.customer_id <> :customerId
      LIMIT 1`,
    { replacements: { workspaceId, deviceId, customerId, hours: DEVICE_WINDOW_HOURS }, type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}

module.exports = { FEATURE, DEVICE_WINDOW_HOURS, planGateOn, guardOn, planLocked, frozenReason, customerBlocked, deviceSpentForOther };
