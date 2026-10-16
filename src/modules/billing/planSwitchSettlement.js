'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { recordAudit } = require('../audit/auditService');
const rules = require('./planSwitchRules');

/**
 * What a plan switch (billing/planSwitchService) asks of the charge path
 * (billing/subscriptionChargeService), kept apart so the charge service can
 * load it without a cycle. Everything here follows the rows, never
 * PLAN_SWITCH_ENABLED: a switch already made finishes the same way with the
 * flag off, since its money or its moment is real either way.
 *
 *   - An upgrade's charge carries target_plan_id like a pay-per-order move's;
 *     its plan_switches row is what tells the two apart. Paid, an upgrade
 *     changes the plan and keeps the period; a move (from a free plan) starts
 *     a full period, as a pay-per-order move does.
 *   - Paid while the store no longer is what the switch was priced for, the
 *     money is credited instead (subscriptionChargeService.settleLateMovePayment).
 *   - A void charge closes its switch with the same word (cancelled,
 *     replaced, expired); a reversed payment reopens it.
 *   - A scheduled downgrade prices the charge for the period after its moment.
 */

const OPEN = rules.OPEN_STATUSES;

/** The switch a charge pays for, or null (a renewal, or a pay-per-order move). */
async function switchOfCharge(invoice, transaction, { lock = false } = {}) {
  if (!invoice || !invoice.targetPlanId) return null;
  return db.PlanSwitch.findOne({
    where: { billingInvoiceId: invoice.id },
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
}

async function audit(sw, action, { before = null, after = null, metadata = {}, actorUserId = null, req = null }, transaction) {
  await recordAudit({
    workspaceId: sw.workspaceId,
    actorUserId,
    action,
    entityType: 'PlanSwitch',
    entityId: sw.id,
    before,
    after,
    metadata: {
      kind: sw.kind,
      fromPlanId: sw.fromPlanId,
      fromBillingCycle: sw.fromBillingCycle,
      toPlanId: sw.toPlanId,
      toBillingCycle: sw.toBillingCycle,
      billingInvoiceId: sw.billingInvoiceId,
      ...metadata,
    },
    req,
    transaction,
  });
}

/** An open switch that no longer fits the store is closed as dropped, with why. */
async function drop(sw, reason, transaction, { actorUserId = null, req = null } = {}) {
  if (!sw || !OPEN.includes(sw.status)) return false;
  const before = { status: sw.status };
  await sw.update({ status: 'dropped', endedAt: new Date(), endReason: String(reason).slice(0, 40) }, { transaction });
  await audit(sw, 'subscription.plan_switch_dropped', { before, after: { status: 'dropped', reason }, actorUserId, req }, transaction);
  return true;
}

/**
 * Before a switch's charge is settled: does the money still do what it was
 * for? Resolves { sw, applies, reason }; a charge with no switch (a
 * pay-per-order move) always applies, as before. The subscription is locked.
 */
async function paymentFit(invoice, transaction) {
  // The charge is locked by the caller; the subscription comes next, as on every payment path.
  const sw = await switchOfCharge(invoice, transaction);
  if (!sw) return { sw: null, applies: true, reason: null };
  const subscription = await db.Subscription.findByPk(invoice.subscriptionId, { transaction, lock: transaction.LOCK.UPDATE });
  const { applies, reason } = rules.chargeStillApplies({ subscription, sw, invoice });
  return { sw, applies, reason };
}

/**
 * Money for a switch's charge that was void when it arrived: applied only
 * if the store is still as it was priced, the plan is still on offer and
 * nothing else is waiting. Resolves { applies, reason }.
 */
async function lateFit(invoice, sw, subscription, transaction) {
  const { Op } = db.Sequelize;
  const [target, otherPending, otherOpen] = await Promise.all([
    sw.toPlanId ? db.Plan.findByPk(sw.toPlanId, { transaction }) : null,
    db.BillingInvoice.findOne({ where: { subscriptionId: invoice.subscriptionId, status: 'pending', id: { [Op.ne]: invoice.id } }, attributes: ['id'], transaction }),
    db.PlanSwitch.findOne({ where: { subscriptionId: invoice.subscriptionId, status: OPEN, id: { [Op.ne]: sw.id } }, attributes: ['id'], transaction }),
  ]);
  const targetOffered = Boolean(target && target.isActive && target.isPublic && !(Number(target.perOrderFeeAmount) > 0));
  return rules.chargeStillApplies({
    subscription,
    sw,
    invoice,
    late: true,
    targetOffered,
    otherPending: Boolean(otherPending),
    otherOpen: Boolean(otherOpen),
  });
}

/**
 * An upgrade's charge was paid: the new plan and cycle from now, the paid
 * period kept as it is (it was paid for, and the days left of it just were).
 * A period still running is active again; one that has ended stays as the
 * lifecycle reads it, and its renewal is the new plan's price.
 */
async function applyUpgrade(invoice, subscription, sw, transaction) {
  const running = new Date(subscription.currentPeriodEnd).getTime() > Date.now();
  const before = { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status };
  await subscription.update(
    {
      planId: sw.toPlanId,
      billingCycle: sw.toBillingCycle,
      ...(running ? { status: 'active', graceUntil: null } : {}),
    },
    { transaction }
  );
  await audit(
    sw,
    'subscription.plan_switch_applied',
    {
      before,
      after: { planId: subscription.planId, billingCycle: subscription.billingCycle, status: subscription.status },
      metadata: { paymentSource: invoice.paymentSource, amountPaid: Number(invoice.amountPaid), currency: invoice.currency, currentPeriodEnd: subscription.currentPeriodEnd },
      actorUserId: invoice.recordedByUserId || null,
    },
    transaction
  );
}

/** The switch is done: applied now, whatever it was before (a late payment reopens an expired one). */
async function markApplied(sw, transaction) {
  await sw.update({ status: 'applied', appliedAt: new Date(), endedAt: null, endReason: null }, { transaction });
}

/**
 * A switch's charge was voided: its switch, still waiting, ends as the
 * reason says (planSwitchRules.switchEndForVoid): cancelled, replaced or
 * expired the same way; cancelled by the merchant or a failed payment as
 * cancelled; voided by the console as dropped.
 */
async function closeForVoidedCharge(invoice, reason, transaction) {
  const end = rules.switchEndForVoid(reason);
  if (!invoice.targetPlanId || !end) return 0;
  const [closed] = await db.PlanSwitch.update(
    { status: end.status, endedAt: new Date(), ...(end.endReason ? { endReason: end.endReason } : {}) },
    { where: { billingInvoiceId: invoice.id, status: 'pending' }, transaction }
  );
  return closed;
}

/**
 * A payment by hand that applied a switch was reversed (the charge is
 * pending again and the store back on its old plan): the switch waits for
 * its charge again. A switch asked for since, on the plan this payment had
 * given, no longer fits and is dropped.
 */
async function reopenAfterReversal(invoice, transaction) {
  const sw = await switchOfCharge(invoice, transaction, { lock: true });
  if (!sw || sw.status !== 'applied') return null;
  const { Op } = db.Sequelize;
  const others = await db.PlanSwitch.findAll({
    where: { subscriptionId: sw.subscriptionId, status: OPEN, id: { [Op.ne]: sw.id } },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  for (const other of others) await drop(other, 'payment_reversed', transaction);
  await sw.update({ status: 'pending', appliedAt: null }, { transaction });
  return sw;
}

/**
 * The plan and cycle a charge for the period starting at `periodStart` is
 * priced on, when a scheduled switch takes effect by then and still fits the
 * store; null otherwise (the store's own plan prices it, as before).
 */
async function scheduledFor(subscription, periodStart, transaction) {
  const sw = await db.PlanSwitch.findOne({ where: { subscriptionId: subscription.id, status: 'scheduled' }, transaction });
  if (!sw || !rules.scheduleCovers(sw.effectiveAt, periodStart)) return null;
  const plan = sw.toPlanId ? await db.Plan.findByPk(sw.toPlanId, { transaction }) : null;
  const fit = rules.scheduleStillApplies({
    subscription,
    sw,
    targetExists: Boolean(plan),
    toPayPerOrder: Boolean(plan && Number(plan.perOrderFeeAmount) > 0),
    walletEnabled: env.wallet.enabled === true,
  });
  if (!fit.applies) return null;
  return { plan, billingCycle: sw.toBillingCycle, switchId: sw.id };
}

module.exports = {
  switchOfCharge,
  drop,
  audit,
  paymentFit,
  lateFit,
  applyUpgrade,
  markApplied,
  closeForVoidedCharge,
  reopenAfterReversal,
  scheduledFor,
};
