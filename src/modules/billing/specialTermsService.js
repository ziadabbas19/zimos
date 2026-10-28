'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const referralPricing = require('../referrals/referralPricing');
const { addMonths, addBillingPeriod } = require('./planPricing');

/**
 * Special terms a platform admin grants a subscription outside normal plan
 * pricing (subscriptions.manage) — a promotion, a bundle deal, free months.
 * Every grant needs a note saying what was agreed and why, and is audited as
 * a platform-level entry.
 *
 *   free_months      Covers the subscription for N more months with no
 *                    charge. The window starts where the subscription's
 *                    current coverage ends (its period end, the last paid
 *                    charge's end or an earlier comp's end, whichever is
 *                    latest), or now if that is already past — a lapsed
 *                    merchant's gap is forgiven, not billed. The period end
 *                    moves to the end of the window and an unpaid
 *                    subscription becomes active. The next charge starts after
 *                    the window (subscriptionChargeService.createCharge), and
 *                    a charge already open is moved to start there too, so
 *                    the comped months are never also billed.
 *
 *   price_override   The next N charges are priced at a fixed amount instead
 *                    of the plan price, in the plan's currency. A charge
 *                    already open is re-priced now and counts as the first.
 *                    Otherwise it goes through the charge path unchanged: a
 *                    referral discount still comes off the overridden price,
 *                    and the commission is on what is paid. One override at a
 *                    time.
 *
 * Grants cannot be edited or revoked yet (see the report).
 */

const KINDS = ['free_months', 'price_override'];

function serializeTerm(term, now = new Date()) {
  const active =
    term.kind === 'free_months'
      ? new Date(term.endsAt) > now
      : Number(term.chargesUsed) < Number(term.chargesTotal);
  return {
    id: term.id,
    kind: term.kind,
    active,
    months: term.months,
    startsAt: term.startsAt,
    endsAt: term.endsAt,
    priceAmount: term.priceAmount == null ? null : Number(term.priceAmount),
    currency: term.currency,
    chargesTotal: term.chargesTotal,
    chargesUsed: term.chargesUsed,
    chargesLeft: term.kind === 'price_override' ? Number(term.chargesTotal) - Number(term.chargesUsed) : null,
    note: term.note,
    createdBy: term.createdBy ? { id: term.createdBy.id, fullName: term.createdBy.fullName } : null,
    createdAt: term.createdAt,
  };
}

async function listTerms(subscriptionId) {
  const terms = await db.SubscriptionTerm.findAll({
    where: { subscriptionId },
    include: [{ model: db.User, as: 'createdBy', attributes: ['id', 'fullName'] }],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'ASC'],
    ],
  });
  return terms.map((t) => serializeTerm(t));
}

/** The price override with charges left for this subscription, if any. */
async function activePriceOverride(subscriptionId, { transaction, lock = false } = {}) {
  return db.SubscriptionTerm.findOne({
    where: {
      subscriptionId,
      kind: 'price_override',
      chargesUsed: { [Op.lt]: db.sequelize.col('charges_total') },
    },
    order: [['createdAt', 'DESC']],
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
}

/** The end of the latest free-months window, or null. */
async function compCoveredUntil(subscriptionId, transaction) {
  const latest = await db.SubscriptionTerm.findOne({
    where: { subscriptionId, kind: 'free_months' },
    order: [['endsAt', 'DESC']],
    attributes: ['endsAt'],
    transaction,
  });
  return latest ? new Date(latest.endsAt) : null;
}

async function lockSubscription(workspaceId, transaction) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!subscription) throw new NotFoundError('Subscription');
  if (subscription.status === 'cancelled') {
    throw new ConflictError('This subscription is cancelled, so special terms cannot be granted.', 'SUBSCRIPTION_CANCELLED');
  }
  return subscription;
}

async function auditGrant(req, term, subscription, extra, transaction) {
  const { id, createdAt, createdBy, active, chargesLeft, ...state } = serializeTerm(term);
  await recordAudit({
    actorUserId: req.user.id,
    action: 'subscription.special_terms_grant',
    entityType: 'SubscriptionTerm',
    entityId: term.id,
    after: state,
    metadata: { workspaceId: subscription.workspaceId, subscriptionId: subscription.id, ...extra },
    req,
    transaction,
  });
}

async function grantFreeMonths(subscription, { months, note }, req, transaction, now) {
  const lastPaid = await db.BillingInvoice.findOne({
    where: { subscriptionId: subscription.id, status: 'paid' },
    order: [['periodEnd', 'DESC']],
    attributes: ['periodEnd'],
    transaction,
  });
  const lastComp = await compCoveredUntil(subscription.id, transaction);
  const coveredUntil = Math.max(
    new Date(subscription.currentPeriodEnd).getTime(),
    lastPaid ? new Date(lastPaid.periodEnd).getTime() : 0,
    lastComp ? lastComp.getTime() : 0
  );
  const startsAt = new Date(Math.max(coveredUntil, now.getTime()));
  const endsAt = addMonths(startsAt, months);

  const term = await db.SubscriptionTerm.create(
    {
      subscriptionId: subscription.id,
      workspaceId: subscription.workspaceId,
      kind: 'free_months',
      months,
      startsAt,
      endsAt,
      note,
      createdByUserId: req.user.id,
    },
    { transaction }
  );

  const periodEndBefore = subscription.currentPeriodEnd;
  const statusBefore = subscription.status;
  await subscription.update(
    {
      currentPeriodEnd: endsAt,
      ...(startsAt.getTime() <= now.getTime() ? { currentPeriodStart: startsAt } : {}),
      // Covered now, so no longer unpaid. A trial runs on into the comp.
      ...(subscription.status === 'trialing' ? {} : { status: 'active' }),
      graceUntil: null,
    },
    { transaction }
  );

  // An open charge would bill the comped months: move it past the window.
  const open = await db.BillingInvoice.findOne({
    where: { subscriptionId: subscription.id, status: 'pending' },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (open) {
    await open.update({ periodStart: endsAt, periodEnd: addBillingPeriod(endsAt, subscription.billingCycle) }, { transaction });
  }

  await auditGrant(
    req,
    term,
    subscription,
    {
      periodEndBefore,
      periodEndAfter: endsAt,
      statusBefore,
      statusAfter: subscription.status,
      redatedChargeId: open ? open.id : null,
    },
    transaction
  );
  return term;
}

async function grantPriceOverride(subscription, { priceAmount, charges, note }, req, transaction) {
  const plan = subscription.planId ? await db.Plan.findByPk(subscription.planId, { transaction }) : null;
  if (!plan) throw new ConflictError('This subscription has no plan to price.', 'NO_PLAN');
  if (await activePriceOverride(subscription.id, { transaction })) {
    throw new ConflictError(
      'A special price is already in effect for this subscription. It has to run out before another is granted.',
      'SPECIAL_PRICE_ACTIVE'
    );
  }

  const term = await db.SubscriptionTerm.create(
    {
      subscriptionId: subscription.id,
      workspaceId: subscription.workspaceId,
      kind: 'price_override',
      priceAmount,
      currency: plan.currency,
      chargesTotal: charges,
      chargesUsed: 0,
      note,
      createdByUserId: req.user.id,
    },
    { transaction }
  );

  // The "next charge" may already exist: re-price it now, as the first use.
  const open = await db.BillingInvoice.findOne({
    where: { subscriptionId: subscription.id, status: 'pending' },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  let repriced = null;
  if (open && open.currency === plan.currency) {
    // The code's discount on that payment, as the charge service prices it (its schedule or its one discount).
    const sub = await db.Subscription.findByPk(open.subscriptionId, { attributes: ['billingCycle'], transaction });
    const { discountAmount } = await referralPricing.forPayment(
      open,
      { cycle: open.targetBillingCycle || (sub ? sub.billingCycle : 'monthly'), gross: priceAmount, monthlyPrice: Number(plan.monthlyPriceAmount) },
      transaction
    );
    repriced = { from: Number(open.grossAmount), to: priceAmount };
    await open.update(
      { grossAmount: priceAmount, discountAmount, amount: priceAmount - discountAmount, specialTermsId: term.id },
      { transaction }
    );
    await term.update({ chargesUsed: 1 }, { transaction });
  }

  await auditGrant(req, term, subscription, { repricedChargeId: open && repriced ? open.id : null, repriced }, transaction);
  return term;
}

/**
 * Grants special terms to the workspace's subscription. `body` is
 * { kind: 'free_months', months, note } or
 * { kind: 'price_override', priceAmount, charges, note }.
 */
async function grant(workspaceId, body, req, { now = new Date() } = {}) {
  return db.sequelize.transaction(async (transaction) => {
    const subscription = await lockSubscription(workspaceId, transaction);
    const term =
      body.kind === 'free_months'
        ? await grantFreeMonths(subscription, body, req, transaction, now)
        : await grantPriceOverride(subscription, body, req, transaction);
    return serializeTerm(term, now);
  });
}

module.exports = { KINDS, grant, listTerms, activePriceOverride, compCoveredUntil, serializeTerm };
