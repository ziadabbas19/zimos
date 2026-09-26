'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, AuthorizationError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { PERMISSIONS } = require('../../core/security/permissions');
const { recordAudit } = require('../audit/auditService');
const { setConfirmationState } = require('../orders/orderStateService');
const { assertNotShipped, SHIPMENT_IN_MOTION } = require('../orders/shipmentLifecycle');
const carrierShipmentService = require('../shipping/carrierShipmentService');
const inventoryService = require('../inventory/inventoryService');

/*
 * Task lifecycle
 *
 *   queued ──claim──▶ in_progress ──outcome──▶ done        (confirmed / rejected)
 *     ▲                  │  │
 *     │                  │  └──outcome──▶ queued           (unreachable / postponed,
 *     │                  │                                   next_retry_at set)
 *     └──release / lock expiry
 *
 * A claim locks the task to one agent for CONFIRMATION_LOCK_TTL_MINUTES. There
 * is no job runner, so an expired lock is released lazily: every read of the
 * queue and every claim first runs releaseExpiredLocks. Until then the holder
 * can still record an outcome — nobody else has taken the task.
 *
 * A done task can be corrected (confirmed ⇄ rejected) by a manager while the
 * order hasn't shipped. Every outcome — queue call, order page, correction —
 * goes through applyOutcome or correctOutcome below, so stock and the
 * customer's rejection counter move exactly once per change.
 */

const RETRY_DELAYS_HOURS = { unreachable: 4, postponed: 24 };
const TERMINAL = ['confirmed', 'rejected'];

const lockTtlMs = () => env.confirmation.lockTtlMinutes * 60 * 1000;
const lockCutoff = () => new Date(Date.now() - lockTtlMs());

function lockExpiresAt(task) {
  if (task.status !== 'in_progress' || !task.lockedAt) return null;
  return new Date(new Date(task.lockedAt).getTime() + lockTtlMs());
}

function lockIsLive(task) {
  const expires = lockExpiresAt(task);
  return Boolean(task.lockedByUserId && expires && expires > new Date());
}

const userSummary = (user) => (user ? { id: user.id, fullName: user.fullName } : null);

// ---------------------------------------------------------------------------
// Loading and shaping tasks
// ---------------------------------------------------------------------------

// Every task this module returns carries its order with the order's items
// (the agent needs what was bought to confirm it on the call, and the
// dashboard renders the item count from `order.items`), who holds its lock,
// and its attempts with the agent who recorded each.
const taskInclude = () => [
  {
    model: db.Order,
    as: 'order',
    include: [
      { model: db.OrderItem, as: 'items' },
      { model: db.Shipment, as: 'shipments', attributes: ['id', 'status'] },
    ],
  },
  { model: db.User, as: 'lockedBy', attributes: ['id', 'fullName'] },
  {
    model: db.ConfirmationAttempt,
    as: 'attempts',
    include: [{ model: db.User, as: 'agent', attributes: ['id', 'fullName'] }],
  },
];

/**
 * Whether a done task's outcome may still be corrected — the same rules
 * correctOutcome enforces, so the dashboard only offers what will succeed.
 */
function isCorrectable(task, order) {
  if (task.status !== 'done' || !order) return false;
  if (['fulfilled', 'partially_fulfilled', 'returned'].includes(order.fulfillmentState)) return false;
  if ((order.shipments || []).some((s) => SHIPMENT_IN_MOTION.includes(s.status))) return false;
  if (order.cancelledAt) return false;
  return order.confirmationState === 'confirmed' || order.confirmationState === 'rejected';
}

function serializeTask(task) {
  const json = task.toJSON();
  const { shipments, ...order } = json.order || {};
  const attempts = (json.attempts || [])
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map(({ agent, ...attempt }) => ({ ...attempt, agent: userSummary(agent) }));
  return {
    ...json,
    order: json.order ? order : null,
    lockedBy: task.status === 'in_progress' ? userSummary(json.lockedBy) : null,
    lockExpiresAt: lockExpiresAt(task),
    attempts,
    correctable: isCorrectable(json, json.order),
  };
}

/** Loads tasks by id with everything serializeTask needs, in `ids` order. */
async function loadTasks(workspaceId, ids, transaction) {
  if (ids.length === 0) return [];
  const rows = await db.ConfirmationTask.findAll({
    where: { id: ids, workspaceId },
    include: taskInclude(),
    transaction,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map(serializeTask);
}

async function loadTask(workspaceId, taskId, transaction) {
  const [task] = await loadTasks(workspaceId, [taskId], transaction);
  return task;
}

function lockedError(task) {
  return new AppError('TASK_ALREADY_LOCKED', 'This task is already being worked by another agent', 409, {
    lockedBy: userSummary(task.lockedBy),
    lockExpiresAt: lockExpiresAt(task),
  });
}

const doneError = () =>
  new AppError('TASK_ALREADY_DONE', 'This task already has a final outcome', 409);

// ---------------------------------------------------------------------------
// Lock expiry
// ---------------------------------------------------------------------------

/**
 * Returns every in-progress task whose lock has lapsed to the queue, and
 * audits each one. Also sweeps in-progress tasks that lost their holder (the
 * user was deleted: locked_by_user_id is ON DELETE SET NULL). SKIP LOCKED
 * leaves alone a task someone is finishing right now.
 */
async function releaseExpiredLocks(workspaceId, transaction) {
  const run = async (t) => {
    const released = await db.sequelize.query(
      `WITH expired AS (
         SELECT id, locked_by_user_id, locked_at
           FROM confirmation_tasks
          WHERE workspace_id = $workspaceId
            AND status = 'in_progress'
            AND (locked_by_user_id IS NULL OR locked_at IS NULL OR locked_at < $cutoff)
          FOR UPDATE SKIP LOCKED
       )
       UPDATE confirmation_tasks t
          SET status = 'queued', locked_by_user_id = NULL, locked_at = NULL, updated_at = NOW()
         FROM expired e
        WHERE t.id = e.id
       RETURNING t.id, t.order_id, e.locked_by_user_id AS previous_holder, e.locked_at AS previous_locked_at`,
      { bind: { workspaceId, cutoff: lockCutoff() }, type: QueryTypes.SELECT, transaction: t }
    );
    for (const row of released) {
      await recordAudit({
        workspaceId,
        action: 'confirmation_task.lock_expired',
        entityType: 'ConfirmationTask',
        entityId: row.id,
        before: { status: 'in_progress', lockedByUserId: row.previous_holder, lockedAt: row.previous_locked_at },
        after: { status: 'queued', lockedByUserId: null },
        metadata: { orderId: row.order_id },
        transaction: t,
      });
    }
    return released.length;
  };
  return transaction ? run(transaction) : db.sequelize.transaction(run);
}

// ---------------------------------------------------------------------------
// Claim / release
// ---------------------------------------------------------------------------

/**
 * Claims a task for the calling agent via a conditional UPDATE inside a
 * transaction. The WHERE admits a task that is free, whose lock has expired,
 * or that the caller already holds (a re-claim extends the lock); exactly one
 * of any number of concurrent claims on the same task affects a row, and the
 * rest get a CONFLICT. A done task is never claimable: its outcome is changed
 * only through correctOutcome.
 */
async function claimTask(workspaceId, taskId, req) {
  const agentUserId = req.user.id;
  return db.sequelize.transaction(async (transaction) => {
    await releaseExpiredLocks(workspaceId, transaction);

    const now = new Date();
    const [affected] = await db.sequelize.query(
      `UPDATE confirmation_tasks
          SET status = 'in_progress', locked_by_user_id = $agentUserId, locked_at = $now, updated_at = $now
        WHERE id = $taskId AND workspace_id = $workspaceId
          AND status IN ('queued', 'in_progress')
          AND (locked_by_user_id IS NULL OR locked_by_user_id = $agentUserId OR locked_at < $cutoff)
        RETURNING id, order_id`,
      { bind: { taskId, workspaceId, agentUserId, now, cutoff: lockCutoff() }, type: QueryTypes.SELECT, transaction }
    );

    if (!affected) {
      const task = await db.ConfirmationTask.findOne({
        where: { id: taskId, workspaceId },
        include: [{ model: db.User, as: 'lockedBy', attributes: ['id', 'fullName'] }],
        transaction,
      });
      if (!task) throw new NotFoundError('ConfirmationTask');
      if (task.status === 'done') throw doneError();
      throw lockedError(task);
    }

    await recordAudit({
      workspaceId,
      actorUserId: agentUserId,
      action: 'confirmation_task.claim',
      entityType: 'ConfirmationTask',
      entityId: taskId,
      after: { status: 'in_progress', lockedByUserId: agentUserId, lockedAt: now },
      metadata: { orderId: affected.order_id },
      req,
      transaction,
    });

    return loadTask(workspaceId, taskId, transaction);
  });
}

/**
 * Hands a claimed task back to the queue. The holder may always release it;
 * releasing someone else's lock needs orders.manage.
 */
async function releaseTask(workspaceId, taskId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const task = await db.ConfirmationTask.findOne({
      where: { id: taskId, workspaceId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!task) throw new NotFoundError('ConfirmationTask');
    if (task.status === 'done') throw doneError();
    if (task.status !== 'in_progress' || !task.lockedByUserId) {
      throw new AppError('TASK_NOT_CLAIMED', 'Nobody holds this task', 409);
    }
    const forced = task.lockedByUserId !== req.user.id;
    if (forced && !req.tenant.hasPermission(PERMISSIONS.ORDERS_MANAGE)) {
      throw new AuthorizationError("Only a manager can release another agent's task");
    }

    const before = { status: task.status, lockedByUserId: task.lockedByUserId, lockedAt: task.lockedAt };
    await task.update({ status: 'queued', lockedByUserId: null, lockedAt: null }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'confirmation_task.release',
      entityType: 'ConfirmationTask',
      entityId: task.id,
      before,
      after: { status: 'queued', lockedByUserId: null },
      metadata: { orderId: task.orderId, forced },
      req,
      transaction,
    });

    return loadTask(workspaceId, task.id, transaction);
  });
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

async function releaseOrderStock(workspaceId, orderId, referenceType, actorUserId, transaction) {
  const items = await db.OrderItem.findAll({ where: { orderId }, transaction });
  for (const item of items) {
    if (!item.variantId) continue;
    await inventoryService.release(
      { workspaceId, variantId: item.variantId, quantity: item.quantity, referenceType, referenceId: orderId, actorUserId },
      transaction
    );
  }
}

async function reserveOrderStock(workspaceId, orderId, referenceType, actorUserId, transaction) {
  const items = await db.OrderItem.findAll({ where: { orderId }, transaction });
  for (const item of items) {
    if (!item.variantId) continue;
    await inventoryService.reserve(
      { workspaceId, variantId: item.variantId, quantity: item.quantity, referenceType, referenceId: orderId, actorUserId },
      transaction
    );
  }
}

/**
 * Records one outcome on an open task: the attempt row, the task's new
 * status, the order's confirmation state and — on a rejection — the stock
 * release and the customer's rejection counter. The caller has already
 * checked that the task is open and that the caller may work it.
 */
async function applyOutcome(task, order, { outcome, notes, rejectionReason, source }, req, transaction) {
  const { workspaceId } = task;
  await db.ConfirmationAttempt.create(
    { taskId: task.id, agentUserId: req.user.id, outcome, notes: notes || null, source },
    { transaction }
  );

  const isTerminal = TERMINAL.includes(outcome);
  await task.update(
    {
      status: isTerminal ? 'done' : 'queued',
      outcome,
      rejectionReason: outcome === 'rejected' ? rejectionReason : null,
      attemptCount: task.attemptCount + 1,
      lockedByUserId: null,
      lockedAt: null,
      completedAt: isTerminal ? new Date() : null,
      nextRetryAt:
        !isTerminal && RETRY_DELAYS_HOURS[outcome]
          ? new Date(Date.now() + RETRY_DELAYS_HOURS[outcome] * 60 * 60 * 1000)
          : null,
    },
    { transaction }
  );

  await setConfirmationState(workspaceId, order.id, outcome, req, transaction);

  if (outcome === 'rejected') {
    // Release (not commit) the reservation — stock returns to available,
    // no permanent deduction since nothing shipped.
    await releaseOrderStock(workspaceId, order.id, 'order_rejected', req.user.id, transaction);
    await db.Customer.increment('totalRejectedOrders', { by: 1, where: { id: order.customerId }, transaction });
  }
}

function assertOrderOpen(order) {
  if (order.cancelledAt || order.confirmationState === 'rejected') {
    throw new AppError('ORDER_CANCELLED', 'This order is cancelled', 409);
  }
}

/** A queue call's outcome, recorded by the agent holding the task. */
async function recordOutcome(workspaceId, taskId, { outcome, notes, rejectionReason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const task = await db.ConfirmationTask.findOne({ where: { id: taskId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!task) throw new NotFoundError('ConfirmationTask');
    if (task.status === 'done') throw doneError();
    if (task.lockedByUserId !== req.user.id) {
      throw new AppError('TASK_NOT_LOCKED_BY_YOU', 'You must claim this task before recording an outcome', 403);
    }
    const order = await db.Order.findOne({ where: { id: task.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    assertOrderOpen(order);

    await applyOutcome(task, order, { outcome, notes, rejectionReason, source: 'queue' }, req, transaction);
    return loadTask(workspaceId, task.id, transaction);
  });
}

/** The order's open task, or a fresh one if it never had one. */
async function openTaskForOrder(workspaceId, orderId, transaction) {
  const open = await db.ConfirmationTask.findOne({
    where: { workspaceId, orderId, status: ['queued', 'in_progress'] },
    order: [['createdAt', 'DESC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (open) return open;
  return db.ConfirmationTask.create({ workspaceId, orderId, status: 'queued' }, { transaction });
}

/**
 * Confirm from the order page: the same outcome a queue call records, without
 * claiming first. Refused while another agent holds a live lock on the task —
 * they may be on the phone with the customer right now.
 */
async function confirmFromOrder(workspaceId, orderId, { notes }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');
    assertOrderOpen(order);
    if (order.paymentMethod !== 'cod') {
      throw new AppError('ORDER_NOT_COD', 'Only cash-on-delivery orders are confirmed by phone', 409);
    }
    if (order.confirmationState === 'confirmed') {
      throw new AppError('ORDER_ALREADY_CONFIRMED', 'This order is already confirmed', 409);
    }

    const task = await openTaskForOrder(workspaceId, order.id, transaction);
    if (task.lockedByUserId && task.lockedByUserId !== req.user.id && lockIsLive(task)) {
      task.lockedBy = await db.User.findByPk(task.lockedByUserId, { attributes: ['id', 'fullName'], transaction });
      throw lockedError(task);
    }

    await applyOutcome(task, order, { outcome: 'confirmed', notes, source: 'order_page' }, req, transaction);
    return loadTask(workspaceId, task.id, transaction);
  });
}

/**
 * Cancelling an order closes its open task as rejected, recorded as an
 * order-page attempt so the Done tab shows who did it and why. The caller
 * (orderService.cancelOrder) owns the stock release and the order's state.
 */
async function closeTasksForCancelledOrder(workspaceId, orderId, reason, req, transaction) {
  const tasks = await db.ConfirmationTask.findAll({
    where: { workspaceId, orderId, status: ['queued', 'in_progress'] },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  for (const task of tasks) {
    await db.ConfirmationAttempt.create(
      { taskId: task.id, agentUserId: req.user.id, outcome: 'rejected', notes: reason, source: 'order_page' },
      { transaction }
    );
    await task.update(
      {
        status: 'done',
        outcome: 'rejected',
        // A cancellation reason may be up to 500 characters; the column holds 300.
        rejectionReason: reason.slice(0, 300),
        attemptCount: task.attemptCount + 1,
        lockedByUserId: null,
        lockedAt: null,
        nextRetryAt: null,
        completedAt: new Date(),
      },
      { transaction }
    );
  }
}

/**
 * Corrects a done task's outcome while the order hasn't shipped.
 *
 *   confirmed → rejected  cancels any not-yet-collected shipment (at the
 *                         courier first), releases stock, counts a rejection.
 *   rejected  → confirmed only for a rejection recorded on a call (the order
 *                         has no cancelledAt — a merchant cancellation stays
 *                         cancelled); re-reserves stock, 409 INSUFFICIENT_STOCK
 *                         if it's gone, and uncounts the rejection.
 *
 * The order's confirmation state, not the task's outcome, is the truth being
 * corrected.
 */
async function correctOutcome(workspaceId, taskId, { outcome, reason, notes, acknowledgeManualCancel = false }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const task = await db.ConfirmationTask.findOne({ where: { id: taskId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!task) throw new NotFoundError('ConfirmationTask');
    if (task.status !== 'done') {
      throw new AppError('TASK_NOT_DONE', 'Only a finished task can be corrected; record an outcome instead', 409);
    }
    const order = await db.Order.findOne({ where: { id: task.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    const previous = order.confirmationState;
    if (previous === outcome) {
      throw new AppError('OUTCOME_UNCHANGED', `This order is already ${outcome}`, 409);
    }
    if (order.cancelledAt) {
      throw new AppError(
        'CORRECTION_NOT_ALLOWED',
        'This order was cancelled from the order page; a cancellation cannot be undone here',
        409
      );
    }
    if (!TERMINAL.includes(previous)) {
      throw new AppError('CORRECTION_NOT_ALLOWED', 'This order has no final outcome to correct', 409);
    }
    await assertNotShipped(order, transaction);

    if (outcome === 'rejected') {
      // A shipment booked with a courier is cancelled there first; if the
      // courier refuses, this throws and the correction rolls back.
      await carrierShipmentService.cancelCarrierShipmentsForOrder(workspaceId, order.id, transaction, {
        acknowledgeManualCancel,
        req,
        trigger: 'confirmation_correction',
      });
      await db.Shipment.update({ status: 'cancelled' }, { where: { orderId: order.id, status: 'created' }, transaction });
      await releaseOrderStock(workspaceId, order.id, 'order_rejected', req.user.id, transaction);
      await db.Customer.increment('totalRejectedOrders', { by: 1, where: { id: order.customerId }, transaction });
    } else {
      await reserveOrderStock(workspaceId, order.id, 'order_reconfirmed', req.user.id, transaction);
      await db.Customer.update(
        { totalRejectedOrders: db.sequelize.literal('GREATEST(total_rejected_orders - 1, 0)') },
        { where: { id: order.customerId }, transaction }
      );
    }

    await setConfirmationState(workspaceId, order.id, outcome, req, transaction);
    await db.ConfirmationAttempt.create(
      {
        taskId: task.id,
        agentUserId: req.user.id,
        outcome,
        notes: notes ? `${reason}\n${notes}` : reason,
        source: 'correction',
        previousOutcome: previous,
      },
      { transaction }
    );
    await task.update(
      { outcome, rejectionReason: outcome === 'rejected' ? reason : null, completedAt: new Date() },
      { transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'confirmation_task.correct',
      entityType: 'ConfirmationTask',
      entityId: task.id,
      before: { outcome: previous },
      after: { outcome },
      metadata: { orderId: order.id, reason },
      req,
      transaction,
    });

    return loadTask(workspaceId, task.id, transaction);
  });
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/*
 * One keyset per tab. Each is a row expression compared against the same
 * expression evaluated for the cursor's task, so paging is stable while tasks
 * are claimed and finished around it.
 *
 *   pending      due first: COALESCE(next_retry_at, created_at), id ASC
 *   in_progress  the viewer's own first, then oldest lock: mine_rank, locked_at, id ASC
 *   done         most recently finished first: COALESCE(completed_at, updated_at), id DESC
 */
const TABS = {
  pending: {
    status: 'queued',
    key: 'COALESCE(t.next_retry_at, t.created_at), t.id',
    direction: 'ASC',
    order: 'COALESCE(t.next_retry_at, t.created_at) ASC, t.id ASC',
  },
  in_progress: {
    status: 'in_progress',
    key: 'CASE WHEN t.locked_by_user_id = $viewerId THEN 0 ELSE 1 END, t.locked_at, t.id',
    direction: 'ASC',
    order: 'CASE WHEN t.locked_by_user_id = $viewerId THEN 0 ELSE 1 END ASC, t.locked_at ASC, t.id ASC',
  },
  done: {
    status: 'done',
    key: 'COALESCE(t.completed_at, t.updated_at), t.id',
    direction: 'DESC',
    order: 'COALESCE(t.completed_at, t.updated_at) DESC, t.id DESC',
  },
};

// `queued` is the old name of the Pending tab; the dashboard used it before
// the tabs existed and still-open tabs may send it.
const tabFor = (status) => TABS[status === 'queued' ? 'pending' : status];

/**
 * One page of a queue tab. `mine` narrows In progress to tasks the viewer
 * holds and Done to tasks the viewer recorded an attempt on; Pending has no
 * owner, so it ignores it.
 */
async function listQueue(workspaceId, { status = 'pending', mine = false, cursor, limit = 50 } = {}, req) {
  await releaseExpiredLocks(workspaceId);

  const tab = tabFor(status);
  const viewerId = req.user.id;
  const conditions = ['t.workspace_id = $workspaceId', 't.status = $status'];
  const bind = { workspaceId, status: tab.status, viewerId, limit: limit + 1 };

  if (mine && tab.status === 'in_progress') conditions.push('t.locked_by_user_id = $viewerId');
  if (mine && tab.status === 'done') {
    conditions.push('EXISTS (SELECT 1 FROM confirmation_attempts a WHERE a.task_id = t.id AND a.agent_user_id = $viewerId)');
  }

  if (cursor) {
    const anchor = await db.ConfirmationTask.findOne({ where: { id: cursor, workspaceId }, attributes: ['id'] });
    if (!anchor) {
      throw new ValidationError(
        [{ field: 'cursor', message: 'Cursor does not point at a confirmation task in this workspace' }],
        'Invalid query'
      );
    }
    bind.cursor = cursor;
    const comparison = tab.direction === 'ASC' ? '>' : '<';
    conditions.push(
      `(${tab.key}) ${comparison} (SELECT ${tab.key} FROM confirmation_tasks t WHERE t.id = $cursor)`
    );
  }

  const rows = await db.sequelize.query(
    `SELECT t.id FROM confirmation_tasks t
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${tab.order}
      LIMIT $limit`,
    { bind, type: QueryTypes.SELECT }
  );
  const hasMore = rows.length > limit;
  const ids = rows.slice(0, limit).map((row) => row.id);
  const tasks = await loadTasks(workspaceId, ids);
  return { tasks, nextCursor: hasMore ? ids[ids.length - 1] : null };
}

/** Tab counts for the queue and the dashboard home tile. */
async function queueCounts(workspaceId, req) {
  await releaseExpiredLocks(workspaceId);
  const [row] = await db.sequelize.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'queued' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))::int AS pending_due,
       COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
       COUNT(*) FILTER (WHERE status = 'in_progress' AND locked_by_user_id = $viewerId)::int AS in_progress_mine,
       COUNT(*) FILTER (WHERE status = 'done')::int AS done
     FROM confirmation_tasks
     WHERE workspace_id = $workspaceId`,
    { bind: { workspaceId, viewerId: req.user.id }, type: QueryTypes.SELECT }
  );
  return {
    pending: row.pending,
    pendingDue: row.pending_due,
    inProgress: row.in_progress,
    inProgressMine: row.in_progress_mine,
    done: row.done,
  };
}

/**
 * The order's current confirmation task, as the order page shows it: null for
 * an order that never had one (prepaid).
 */
async function taskSummaryForOrder(workspaceId, orderId) {
  const task = await db.ConfirmationTask.findOne({
    where: { workspaceId, orderId },
    include: [{ model: db.User, as: 'lockedBy', attributes: ['id', 'fullName'] }],
    order: [['createdAt', 'DESC']],
  });
  if (!task) return null;
  const live = lockIsLive(task);
  return {
    id: task.id,
    status: task.status,
    outcome: task.outcome,
    attemptCount: task.attemptCount,
    nextRetryAt: task.nextRetryAt,
    completedAt: task.completedAt,
    lockedBy: live ? userSummary(task.lockedBy) : null,
    lockedAt: live ? task.lockedAt : null,
    lockExpiresAt: live ? lockExpiresAt(task) : null,
  };
}

module.exports = {
  claimTask,
  releaseTask,
  recordOutcome,
  confirmFromOrder,
  correctOutcome,
  closeTasksForCancelledOrder,
  releaseExpiredLocks,
  listQueue,
  queueCounts,
  taskSummaryForOrder,
};
