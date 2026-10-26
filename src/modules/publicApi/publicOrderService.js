'use strict';

const db = require('../../db/models');
const { AppError, AuthorizationError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { PERMISSIONS } = require('../../core/security/permissions');
const orderService = require('../orders/orderService');
const confirmationService = require('../cod/confirmationService');
const paymentService = require('../payments/paymentService');
const { serializeShipment } = require('./publicOrderSerializer');
const { serializeOrders } = require('./publicOrderOptions');

/**
 * The public API's order operations. Nothing here decides anything about an
 * order: each call goes through the same service the dashboard uses —
 * orderService, the COD confirmation queue, the payments module — so the
 * rules, the stock movements, the courier bookings and the audit trail are
 * the ones the merchant already knows. This file only translates a request
 * from an integration into the calls a person in the dashboard would make.
 */

async function getOrder(workspaceId, orderId) {
  const [order] = await serializeOrders(workspaceId, [await orderService.getOrder(workspaceId, orderId)]);
  return order;
}

/** The order an integration knows only by the number printed on it ("1042" or "#1042"). */
async function getOrderByNumber(workspaceId, orderNumber) {
  const number = String(orderNumber).trim().replace(/^#/, '');
  const order = await db.Order.findOne({ where: { workspaceId, orderNumber: number }, attributes: ['id'] });
  if (!order) throw new NotFoundError('Order');
  return getOrder(workspaceId, order.id);
}

async function listOrders(workspaceId, query) {
  const { orders, nextCursor } = await orderService.listOrders(workspaceId, query);
  return { orders: await serializeOrders(workspaceId, orders), nextCursor };
}

async function listShipments(workspaceId, orderId) {
  const shipments = await orderService.listShipments(workspaceId, orderId);
  return shipments.map(serializeShipment);
}

const TERMINAL = ['confirmed', 'rejected'];

/** The order's open confirmation task, or a fresh queued one — under the order's row lock. */
async function openTaskId(workspaceId, orderId) {
  return db.sequelize.transaction(async (transaction) => {
    await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    const open = await db.ConfirmationTask.findOne({
      where: { workspaceId, orderId, status: ['queued', 'in_progress'] },
      order: [['createdAt', 'DESC']],
      transaction,
    });
    if (open) return open.id;
    const created = await db.ConfirmationTask.create({ workspaceId, orderId, status: 'queued' }, { transaction });
    return created.id;
  });
}

/**
 * Sets a COD order's confirmation state — what a call-centre agent records:
 *
 *   pending order  → confirmed / rejected / unreachable / postponed, recorded
 *                    as an outcome on its confirmation task (claimed, then
 *                    recorded, exactly as the queue does it)
 *   final outcome  → the other final outcome, as a correction (needs a
 *                    `reason`, and orders.manage like the dashboard's
 *                    correction button)
 *
 * A rejection releases the order's stock and a confirmation keeps it; a
 * correction to rejected also cancels a courier booking — all inside
 * confirmationService, never here.
 */
async function setConfirmation(workspaceId, orderId, { outcome, reason, notes, acknowledgeManualCancel }, req) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  if (order.paymentMethod !== 'cod') {
    throw new AppError('ORDER_NOT_COD', 'Only cash-on-delivery orders go through confirmation', 409);
  }

  const current = order.confirmationState;
  if (current === outcome) throw new AppError('OUTCOME_UNCHANGED', `This order is already ${outcome}`, 409);

  if (TERMINAL.includes(current)) {
    if (!TERMINAL.includes(outcome)) {
      throw new AppError(
        'CORRECTION_NOT_ALLOWED',
        'A confirmed or rejected order can only be changed to the other of the two',
        409
      );
    }
    if (!req.tenant.hasPermission(PERMISSIONS.ORDERS_MANAGE)) {
      throw new AuthorizationError(`Missing required permission: ${PERMISSIONS.ORDERS_MANAGE}`);
    }
    if (!reason) {
      throw new ValidationError([{ field: 'reason', message: '"reason" is required to change a final outcome' }]);
    }
    const task = await db.ConfirmationTask.findOne({
      where: { workspaceId, orderId, status: 'done' },
      order: [['completedAt', 'DESC']],
    });
    if (!task) throw new AppError('CORRECTION_NOT_ALLOWED', 'This order has no recorded outcome to correct', 409);
    await confirmationService.correctOutcome(workspaceId, task.id, { outcome, reason, notes, acknowledgeManualCancel }, req);
  } else if (outcome === 'confirmed') {
    await confirmationService.confirmFromOrder(workspaceId, orderId, { notes }, req);
  } else {
    const taskId = await openTaskId(workspaceId, orderId);
    await confirmationService.claimTask(workspaceId, taskId, req);
    try {
      await confirmationService.recordOutcome(workspaceId, taskId, { outcome, notes, rejectionReason: reason }, req);
    } catch (err) {
      // Don't leave the task locked to the key's creator in the agents' queue.
      await confirmationService.releaseTask(workspaceId, taskId, req).catch(() => {});
      throw err;
    }
  }

  return getOrder(workspaceId, orderId);
}

async function cancelOrder(workspaceId, orderId, body, req) {
  await orderService.cancelOrder(workspaceId, orderId, body, req);
  return getOrder(workspaceId, orderId);
}

async function createShipment(workspaceId, orderId, body, req) {
  return serializeShipment(await orderService.createShipment(workspaceId, orderId, body, req));
}

async function updateShipment(workspaceId, orderId, shipmentId, body, req) {
  return serializeShipment(await orderService.updateShipment(workspaceId, orderId, shipmentId, body, req));
}

/**
 * The courier (or the fulfilment partner) handed over the cash for a COD
 * order: its cash-on-delivery payment is captured, which moves the order to
 * paid through the payments module. Calling it again for a paid order changes
 * nothing.
 */
async function markCodCollected(workspaceId, orderId, req) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  if (order.paymentMethod !== 'cod') {
    throw new AppError('ORDER_NOT_COD', 'Only cash-on-delivery orders are collected by the courier', 409);
  }
  if (order.financialState !== 'paid') {
    let payment = await db.Payment.findOne({
      where: { workspaceId, orderId, providerCode: 'cod', status: 'authorized' },
      order: [['createdAt', 'DESC']],
    });
    if (!payment) payment = await paymentService.initializePayment(workspaceId, orderId, req);
    await paymentService.capturePayment(workspaceId, payment.id, req);
  }
  return getOrder(workspaceId, orderId);
}

module.exports = {
  getOrder,
  getOrderByNumber,
  listOrders,
  listShipments,
  setConfirmation,
  cancelOrder,
  createShipment,
  updateShipment,
  markCodCollected,
};
