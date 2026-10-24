'use strict';

const env = require('../../config/env');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const statusHistory = require('./orderStatusHistory');

/**
 * Which pipeline stage (orderStage.js) an order may move to from each stage.
 * Anything else is refused with 409 INVALID_STATUS_TRANSITION wherever a
 * person asks for the move: PATCH /orders/:id/status, the bulk action, and a
 * shipment status typed in by hand. What a courier reports is recorded as it
 * comes — the courier is describing the parcel, not asking permission.
 *
 * The stages are coarser than SPEC §4.1's statuses, so the table is its
 * transitions mapped onto them: 'confirmed', 'paid', 'processing' and
 * 'awaiting_pickup' are all ready_to_ship; 'unreachable' and 'postponed' are
 * needs_follow_up; 'in_delivery' is shipped / out_for_delivery; a return the
 * customer asks for lives in the returns module and shows here only once the
 * parcel is back ('returned').
 */
const STAGE_TRANSITIONS = Object.freeze({
  // paid → ready to ship; the shopper switched to cash on delivery → the call queue
  awaiting_payment: ['ready_to_ship', 'pending_confirmation', 'cancelled'],
  pending_confirmation: ['ready_to_ship', 'needs_follow_up', 'cancelled'],
  needs_follow_up: ['pending_confirmation', 'ready_to_ship', 'cancelled'],
  ready_to_ship: ['shipped', 'out_for_delivery', 'delivered', 'cancelled'],
  // back to ready_to_ship: the shipment was cancelled before it got anywhere
  shipped: ['out_for_delivery', 'delivered', 'delivery_failed', 'returned', 'ready_to_ship'],
  out_for_delivery: ['delivered', 'delivery_failed', 'returned'],
  delivery_failed: ['shipped', 'out_for_delivery', 'delivered', 'returned', 'ready_to_ship'],
  delivered: ['returned'],
  // a returned parcel is sent again: a new shipment is booked
  returned: ['ready_to_ship'],
  // un-cancel: back to where the order stood before anyone worked it
  cancelled: ['pending_confirmation', 'awaiting_payment', 'ready_to_ship'],
});

/**
 * The part of the table a person can ask for (PATCH /orders/:id/status, see
 * orderStageChange.js). What is left out happens on its own: an online
 * payment landing, the shopper switching to cash on delivery, a courier
 * cancelling a parcel.
 */
const MANUAL_TARGETS = Object.freeze({
  awaiting_payment: ['cancelled'],
  pending_confirmation: ['ready_to_ship', 'needs_follow_up', 'cancelled'],
  needs_follow_up: ['pending_confirmation', 'ready_to_ship', 'cancelled'],
  ready_to_ship: ['shipped', 'out_for_delivery', 'delivered', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered', 'delivery_failed', 'returned'],
  out_for_delivery: ['delivered', 'delivery_failed', 'returned'],
  delivery_failed: ['shipped', 'out_for_delivery', 'delivered', 'returned'],
  delivered: ['returned'],
  returned: [],
  // "Reopen": the order goes back to where it stood before anyone worked it —
  // the call queue (COD), awaiting payment or ready to ship (prepaid).
  cancelled: ['pending_confirmation'],
});

/** The stages the order page may offer for an order in `stage`. */
function nextStages(stage) {
  return MANUAL_TARGETS[stage] ? [...MANUAL_TARGETS[stage]] : [];
}

function canTransition(from, to) {
  return Boolean(STAGE_TRANSITIONS[from] && STAGE_TRANSITIONS[from].includes(to));
}

function assertTransition(from, to) {
  if (from === to || canTransition(from, to)) return;
  throw new AppError('INVALID_STATUS_TRANSITION', `An order that is "${from}" cannot be moved to "${to}"`, 409, {
    from,
    to,
    allowed: STAGE_TRANSITIONS[from] || [],
  });
}

/**
 * The stage guard for cancelling one shipment, run before the courier is
 * asked: the stage the order will have once the shipment no longer counts
 * must be a move the table above allows (while ORDER_STATUS_GUARDS is on), so
 * a refused move never follows a cancel the courier already made.
 */
async function assertShipmentCancelMove(orderId, shipmentId, transaction) {
  if (!env.orderStatusGuards) return;
  const to = await statusHistory.stageOf(orderId, transaction, { withoutShipmentId: shipmentId });
  const last = await statusHistory.lastRow(orderId, transaction);
  if (to && last && last.toStatus !== to) assertTransition(last.toStatus, to);
}

/**
 * Records the order's stage in order_status_history if it has moved since the
 * last row (orderStatusHistory.sync). Called, in the caller's transaction, by
 * everything that changes an order's state — the three setters below, the
 * shipment lifecycle, cancellation, the online payment paths. `enforce`
 * refuses a move the table above does not allow, while ORDER_STATUS_GUARDS is on.
 */
async function trackStage(
  workspaceId,
  orderId,
  { req = null, transaction = null, actorType, actorId, fallbackActor = 'system', reason = null, enforce = false } = {}
) {
  const actor = actorType ? { actorType, actorId: actorId || null } : statusHistory.actorFrom(req, fallbackActor);
  return statusHistory.sync(workspaceId, orderId, {
    transaction,
    ...actor,
    // PATCH /orders/:id/status carries the merchant's reason on the request,
    // so the row is written with it whichever setter records the move first.
    reason: reason || (req && req.stageChangeReason) || null,
    guard: enforce && env.orderStatusGuards ? assertTransition : null,
  });
}

/**
 * The only place allowed to write Order.confirmationState /
 * financialState / fulfillmentState. Keeping these three independent (per
 * the product requirement that Delivered must never be assumed to mean
 * Paid) means each caller only ever touches the one column relevant to it.
 */
async function setConfirmationState(workspaceId, orderId, state, req, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
  if (!order) throw new NotFoundError('Order');
  // Paid by InstaPay / a wallet: not confirmed for shipping until the proof is approved.
  if (state === 'confirmed') await require('../manualPayments/manualPaymentService').assertConfirmable(order, transaction);
  const before = order.confirmationState;
  // Entering 'confirmed': the pay-per-order fee is taken here, once, or the
  // confirmation is refused (402 ORDER_LOCKED) — billing/confirmFeeService.
  // The wallet is the last lock: the callers hold the order's row already.
  const contactLock =
    state === 'confirmed' && before !== 'confirmed'
      ? await require('../billing/confirmFeeService').settleOnConfirmation(order, { strict: true, actorUserId: req && req.user ? req.user.id : null }, transaction)
      : order.contactLock;
  await order.update({ confirmationState: state, confirmedAt: confirmedAtFor(order, state), contactLock }, { transaction });
  await recordAudit({
    workspaceId,
    actorUserId: req.user ? req.user.id : null,
    action: 'order.confirmation_state_change',
    entityType: 'Order',
    entityId: order.id,
    before: { confirmationState: before },
    after: { confirmationState: state },
    req,
    transaction,
  });
  await trackStage(workspaceId, order.id, { req, transaction });
  return order;
}

// The financial states an order already counts as paid in (orderStage PAID_STATES_SQL).
const PAID_BEFORE = ['paid', 'partially_paid', 'refunded', 'partially_refunded'];

/**
 * confirmed_at follows the confirmation state (migration 115): stamped on the
 * move into 'confirmed', kept while it stays there, cleared when it leaves.
 */
function confirmedAtFor(order, state, now = new Date()) {
  if (state !== 'confirmed') return null;
  return order.confirmationState === 'confirmed' && order.confirmedAt ? order.confirmedAt : now;
}

async function setFinancialState(workspaceId, orderId, state, req, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
  if (!order) throw new NotFoundError('Order');
  const before = order.financialState;
  // An order paid online reaches its confirmed stage with the payment
  // (orders/orderLock): unlocked, or due with its fee taken after the commit.
  const paidNow = ['paid', 'partially_paid'].includes(state) && !PAID_BEFORE.includes(before) && order.paymentMethod !== 'cod';
  const contactLock = paidNow ? await require('../billing/confirmFeeService').markOnPayment(order, transaction) : order.contactLock;
  await order.update({ financialState: state, contactLock }, { transaction });
  await recordAudit({
    workspaceId,
    actorUserId: req && req.user ? req.user.id : null,
    action: 'order.financial_state_change',
    entityType: 'Order',
    entityId: order.id,
    before: { financialState: before },
    after: { financialState: state },
    // A refund's "notify the customer" choice rides to the order.refunded event (auditEventBridge).
    metadata: req && req.notifyCustomer !== undefined ? { notifyCustomer: req.notifyCustomer } : null,
    req,
    transaction,
  });
  await trackStage(workspaceId, order.id, { req, transaction });
  // Digital lines are delivered the moment the order is paid (modules/digital).
  if (state === 'paid' && before !== 'paid') {
    await require('../digital/digitalService').onOrderPaid(workspaceId, order.id, transaction);
    // A product on a billing plan starts its subscription, and the buyer is
    // enrolled in a course sold through the order, from the order.paid event
    // the audit row above records in this transaction (subscriptions/jobs.js,
    // courses/jobs.js): retried until done, never lost to a crash after the commit.
  }
  return order;
}

async function setFulfillmentState(workspaceId, orderId, state, req, transaction) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction });
  if (!order) throw new NotFoundError('Order');
  const before = order.fulfillmentState;
  await order.update({ fulfillmentState: state }, { transaction });
  await recordAudit({
    workspaceId,
    actorUserId: req && req.user ? req.user.id : null,
    action: 'order.fulfillment_state_change',
    entityType: 'Order',
    entityId: order.id,
    before: { fulfillmentState: before },
    after: { fulfillmentState: state },
    req,
    transaction,
  });
  await trackStage(workspaceId, order.id, { req, transaction });
  return order;
}

module.exports = {
  setConfirmationState,
  setFinancialState,
  setFulfillmentState,
  confirmedAtFor,
  STAGE_TRANSITIONS,
  MANUAL_TARGETS,
  nextStages,
  canTransition,
  assertTransition,
  assertShipmentCancelMove,
  trackStage,
};
