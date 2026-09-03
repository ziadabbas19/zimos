'use strict';

const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { setConfirmationState } = require('../orders/orderStateService');
const inventoryService = require('../inventory/inventoryService');

/**
 * Claims a queued confirmation task for the calling agent via a conditional
 * UPDATE ... WHERE locked_by_user_id IS NULL, inside a transaction. Exactly
 * one of any number of concurrent claim attempts on the same task affects a
 * row; everyone else gets 0 rows updated and a CONFLICT, which is what
 * prevents two agents from ever working the same order at once.
 */
async function claimTask(workspaceId, taskId, agentUserId) {
  return db.sequelize.transaction(async (transaction) => {
    const [affectedCount] = await db.ConfirmationTask.update(
      { status: 'in_progress', lockedByUserId: agentUserId, lockedAt: new Date() },
      { where: { id: taskId, workspaceId, lockedByUserId: null }, transaction }
    );

    if (affectedCount === 0) {
      // Either it doesn't exist, or someone already has the lock.
      const task = await db.ConfirmationTask.findOne({ where: { id: taskId, workspaceId }, transaction });
      if (!task) throw new NotFoundError('ConfirmationTask');
      throw new AppError('TASK_ALREADY_LOCKED', 'This task is already being worked by another agent', 409);
    }

    return db.ConfirmationTask.findOne({ where: { id: taskId, workspaceId }, transaction });
  });
}

const RETRY_DELAYS_HOURS = { unreachable: 4, postponed: 24 };

async function recordOutcome(workspaceId, taskId, { outcome, notes, rejectionReason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const task = await db.ConfirmationTask.findOne({ where: { id: taskId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!task) throw new NotFoundError('ConfirmationTask');
    if (task.lockedByUserId !== req.user.id) {
      throw new AppError('TASK_NOT_LOCKED_BY_YOU', 'You must claim this task before recording an outcome', 403);
    }

    await db.ConfirmationAttempt.create(
      { taskId: task.id, agentUserId: req.user.id, outcome, notes },
      { transaction }
    );

    const isTerminal = outcome === 'confirmed' || outcome === 'rejected';
    await task.update(
      {
        status: isTerminal ? 'done' : 'queued',
        outcome,
        rejectionReason: outcome === 'rejected' ? rejectionReason : null,
        attemptCount: task.attemptCount + 1,
        lockedByUserId: null,
        lockedAt: null,
        nextRetryAt:
          !isTerminal && RETRY_DELAYS_HOURS[outcome]
            ? new Date(Date.now() + RETRY_DELAYS_HOURS[outcome] * 60 * 60 * 1000)
            : null,
      },
      { transaction }
    );

    await setConfirmationState(workspaceId, task.orderId, outcome, req, transaction);

    if (outcome === 'rejected') {
      // Release (not commit) the reservation — stock returns to available,
      // no permanent deduction since nothing shipped.
      const order = await db.Order.findByPk(task.orderId, { include: [{ model: db.OrderItem, as: 'items' }], transaction });
      for (const item of order.items) {
        if (!item.variantId) continue;
        await inventoryService.release(
          { workspaceId, variantId: item.variantId, quantity: item.quantity, referenceType: 'order_rejected', referenceId: order.id, actorUserId: req.user.id },
          transaction
        );
      }
      const Customer = db.Customer;
      await Customer.increment('totalRejectedOrders', { by: 1, where: { id: order.customerId }, transaction });
    }

    return task;
  });
}

async function listQueue(workspaceId, { status = 'queued', limit = 50 } = {}) {
  return db.ConfirmationTask.findAll({
    where: { workspaceId, status },
    order: [['createdAt', 'ASC']],
    limit,
    include: [{ model: db.Order, as: 'order' }],
  });
}

module.exports = { claimTask, recordOutcome, listQueue };
