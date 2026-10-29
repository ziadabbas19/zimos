'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');
const { planPrice } = require('./planPricing');
const { availableFeatureKeys } = require('./featureCatalog');

/**
 * The plans offered to the public — on the marketing site's pricing page and
 * at sign-up: active and marked public (plans.is_public, migration 126),
 * ordered by display_order. Only what a buyer needs is served: no plan code,
 * no commission, no debt limit, nothing internal — the pay-per-order plan's
 * fee for one order is its price, so it is served.
 *
 * GET /plans/public is read by every visit to the pricing page, so the list
 * is kept for a few seconds; saving or deleting a plan in the console drops
 * it at once (`invalidate`).
 */

const CACHE_MS = env.isTest ? 0 : 30 * 1000;
let cached = null;

function serializePublicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    currency: plan.currency,
    // Minor units (piastres, cents), like every amount in the API.
    monthlyPrice: planPrice(plan, 'monthly'),
    yearlyPrice: planPrice(plan, 'yearly'),
    trialDays: plan.trialDays,
    // null = unlimited.
    maxStores: plan.maxStores,
    maxFunnelsPerMonth: plan.maxFunnelsPerMonth,
    softOrderQuota: plan.softOrderQuota,
    // Only features that exist today (billing/featureCatalog `available`);
    // whatever else plans.features holds stays stored, unshown.
    features: availableFeatureKeys(plan.features),
  };
}

// A pay-per-order plan (a fee per order, nothing monthly) is never listed
// with the others or chosen at sign-up: it is chosen from the Subscription
// section, while WALLET_ENABLED is on (billing/walletService). The pricing
// page gets it on its own (`payPerOrder` below).
const OFFERED = { isPublic: true, isActive: true, perOrderFeeAmount: 0 };

/**
 * The pay-per-order plan as the pricing page shows it: the fee for one order
 * in minor units, the orders a store places free before any fee
 * (plans.wallet_free_orders), and when the fee is taken — at confirmation
 * while ORDERS_LOCK_ENABLED is on (billing/confirmFeeService), otherwise when
 * the order is placed (walletService.chargeOrderFee).
 */
function serializePayPerOrderPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    currency: plan.currency,
    feePerOrder: Number(plan.perOrderFeeAmount),
    freeOrders: Number(plan.walletFreeOrders || 0),
    feeChargedAt: env.ordersLock.enabled === true ? 'confirmation' : 'placement',
  };
}

/**
 * The one order plans are listed in — here, in the Subscription section
 * (merchantPlansService) and in the console (platformAdminService): display
 * order, then price, then name.
 */
const PLAN_ORDER = Object.freeze([
  ['displayOrder', 'ASC'],
  ['monthlyPriceAmount', 'ASC'],
  ['name', 'ASC'],
]);

async function loadOffered(transaction) {
  return db.Plan.findAll({
    where: OFFERED,
    order: PLAN_ORDER,
    transaction,
  });
}

/**
 * The one the Subscription section offers (walletService.offeredFeePlan:
 * public, active, EGP, nothing monthly), and only while WALLET_ENABLED is on,
 * so the pricing page never shows a plan a merchant can't take. Else null.
 */
async function loadPayPerOrder() {
  // eslint-disable-next-line global-require
  const wallet = require('./walletService');
  if (!wallet.enabled()) return null;
  const plan = await wallet.offeredFeePlan();
  return plan ? serializePayPerOrderPlan(plan) : null;
}

/** GET /plans/public — the list, possibly empty, and the pay-per-order plan or null. */
async function listPublicPlans() {
  if (cached && cached.until > Date.now()) return cached.offer;
  const [plans, payPerOrder] = await Promise.all([loadOffered(), loadPayPerOrder()]);
  const offer = { plans: plans.map(serializePublicPlan), payPerOrder };
  if (CACHE_MS > 0) cached = { offer, until: Date.now() + CACHE_MS };
  return offer;
}

function invalidate() {
  cached = null;
}

/** Whether any plan is offered right now (read fresh, never cached). */
async function anyOffered(transaction) {
  return (await db.Plan.count({ where: OFFERED, transaction })) > 0;
}

/** The offered plan `planId`, or 422 PLAN_NOT_AVAILABLE (unknown, private or inactive). */
async function findOfferedPlan(planId, transaction) {
  const plan = planId ? await db.Plan.findByPk(planId, { transaction }) : null;
  if (!plan || !plan.isActive || !plan.isPublic || Number(plan.perOrderFeeAmount) > 0) {
    throw new AppError('PLAN_NOT_AVAILABLE', 'This plan is not available', 422, [
      { field: 'planId', message: 'Choose one of the plans on offer' },
    ]);
  }
  return plan;
}

module.exports = { listPublicPlans, invalidate, anyOffered, findOfferedPlan, serializePublicPlan, PLAN_ORDER };
