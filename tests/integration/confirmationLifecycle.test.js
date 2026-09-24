'use strict';

// The COD confirmation task lifecycle end to end: claim locks that expire on
// their own, release, the re-claim-a-done-task bug, confirming from the order
// page, correcting a finished outcome, and the queue's tabs and counts.

const {
  app,
  request,
  setupWorkspaceWithProduct,
  addMemberWithRole,
  confirmCodOrder,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function placeOrder(token, workspaceId, variantId, { quantity = 2, paymentMethod = 'cod', phone = '01000003333' } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `cl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity }],
      contact: { fullName: 'Lifecycle Buyer', phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '3 Lock St' },
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

/** A workspace, its owner, two confirmation agents and one COD order. */
async function setup({ stock = 10, quantity = 2 } = {}) {
  const ctx = await setupWorkspaceWithProduct({ stock });
  const ownerToken = ctx.auth.accessToken;
  const agentA = await addMemberWithRole(ownerToken, ctx.workspace.id, 'confirmation_agent', 'Agent Amal');
  const agentB = await addMemberWithRole(ownerToken, ctx.workspace.id, 'confirmation_agent', 'Agent Bassem');
  const order = await placeOrder(ownerToken, ctx.workspace.id, ctx.variant.id, { quantity });
  const task = await db.ConfirmationTask.findOne({ where: { orderId: order.id } });
  const base = `/api/v1/workspaces/${ctx.workspace.id}/confirmation-tasks`;
  return { ...ctx, ownerToken, agentA, agentB, order, task, base };
}

const claim = (ctx, token, taskId = ctx.task.id) =>
  request(app).post(`${ctx.base}/${taskId}/claim`).set(bearer(token)).send({});
const outcome = (ctx, token, body, taskId = ctx.task.id) =>
  request(app).post(`${ctx.base}/${taskId}/outcome`).set(bearer(token)).send(body);
const release = (ctx, token, taskId = ctx.task.id) =>
  request(app).post(`${ctx.base}/${taskId}/release`).set(bearer(token)).send({});
const correct = (ctx, token, body, taskId = ctx.task.id) =>
  request(app).post(`${ctx.base}/${taskId}/correction`).set(bearer(token)).send(body);
const list = (ctx, token, query = '') => request(app).get(`${ctx.base}${query}`).set(bearer(token));
const counts = (ctx, token) => request(app).get(`${ctx.base}/counts`).set(bearer(token));
const confirmOnOrder = (ctx, token, orderId = ctx.order.id) =>
  request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${orderId}/confirmation`).set(bearer(token)).send({});

/** Moves a lock into the past, as if the holder walked away `minutes` ago. */
const ageLock = (taskId, minutes) =>
  db.ConfirmationTask.update({ lockedAt: new Date(Date.now() - minutes * 60 * 1000) }, { where: { id: taskId } });

const variantOf = (ctx) => db.ProductVariant.findByPk(ctx.variant.id);

describe('claim locks', () => {
  it('locks a task to one agent and tells the other who holds it and until when', async () => {
    const ctx = await setup();
    const first = await claim(ctx, ctx.agentA.accessToken);
    expect(first.status).toBe(200);
    expect(first.body.task.status).toBe('in_progress');
    expect(first.body.task.lockedBy).toEqual({ id: ctx.agentA.userId, fullName: 'Agent Amal' });
    expect(new Date(first.body.task.lockExpiresAt) - new Date(first.body.task.lockedAt)).toBe(
      env.confirmation.lockTtlMinutes * 60 * 1000
    );

    const second = await claim(ctx, ctx.agentB.accessToken);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('TASK_ALREADY_LOCKED');
    expect(second.body.error.details.lockedBy).toEqual({ id: ctx.agentA.userId, fullName: 'Agent Amal' });
    expect(second.body.error.details.lockExpiresAt).toBe(first.body.task.lockExpiresAt);

    expect(await db.AuditLog.count({ where: { entityId: ctx.task.id, action: 'confirmation_task.claim' } })).toBe(1);
  });

  it('a re-claim by the holder extends the lock', async () => {
    const ctx = await setup();
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await ageLock(ctx.task.id, 10);
    const again = await claim(ctx, ctx.agentA.accessToken);
    expect(again.status).toBe(200);
    expect(Date.now() - new Date(again.body.task.lockedAt)).toBeLessThan(60 * 1000);
  });

  it('an expired lock returns the task to Pending on the next read, and another agent can claim it', async () => {
    const ctx = await setup();
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await ageLock(ctx.task.id, env.confirmation.lockTtlMinutes + 1);

    const pending = await list(ctx, ctx.agentB.accessToken, '?status=pending');
    expect(pending.status).toBe(200);
    expect(pending.body.tasks.map((t) => t.id)).toEqual([ctx.task.id]);
    expect(pending.body.tasks[0].status).toBe('queued');
    expect(pending.body.tasks[0].lockedBy).toBeNull();

    const audit = await db.AuditLog.findOne({ where: { entityId: ctx.task.id, action: 'confirmation_task.lock_expired' } });
    expect(audit).not.toBeNull();
    expect(audit.beforeState.lockedByUserId).toBe(ctx.agentA.userId);

    const taken = await claim(ctx, ctx.agentB.accessToken);
    expect(taken.status).toBe(200);
    expect(taken.body.task.lockedBy.id).toBe(ctx.agentB.userId);

    // The previous holder can no longer record an outcome.
    const late = await outcome(ctx, ctx.agentA.accessToken, { outcome: 'confirmed' });
    expect(late.status).toBe(403);
    expect(late.body.error.code).toBe('TASK_NOT_LOCKED_BY_YOU');
  });

  it('a claim takes over an expired lock directly, without a read first', async () => {
    const ctx = await setup();
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await ageLock(ctx.task.id, env.confirmation.lockTtlMinutes + 1);
    const taken = await claim(ctx, ctx.agentB.accessToken);
    expect(taken.status).toBe(200);
    expect(taken.body.task.lockedBy.id).toBe(ctx.agentB.userId);
  });

  it('the holder may still record an outcome after expiry if nobody took the task', async () => {
    const ctx = await setup();
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await ageLock(ctx.task.id, env.confirmation.lockTtlMinutes + 1);
    const res = await outcome(ctx, ctx.agentA.accessToken, { outcome: 'confirmed' });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('done');
  });
});

describe('a done task is final', () => {
  it('cannot be claimed or given a second outcome', async () => {
    const ctx = await setup({ quantity: 2 });
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await outcome(ctx, ctx.agentA.accessToken, { outcome: 'rejected', rejectionReason: 'Wrong size' }).expect(200);
    expect((await variantOf(ctx)).reservedStock).toBe(0);

    const reclaim = await claim(ctx, ctx.agentB.accessToken);
    expect(reclaim.status).toBe(409);
    expect(reclaim.body.error.code).toBe('TASK_ALREADY_DONE');

    const again = await outcome(ctx, ctx.agentA.accessToken, { outcome: 'rejected', rejectionReason: 'Again' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TASK_ALREADY_DONE');

    // Stock and the customer's counter moved exactly once.
    expect(await db.InventoryMovement.count({ where: { referenceId: ctx.order.id, type: 'release' } })).toBe(1);
    const order = await db.Order.findByPk(ctx.order.id);
    expect((await db.Customer.findByPk(order.customerId)).totalRejectedOrders).toBe(1);
  });

  it('a cancelled order\'s task cannot be claimed and confirmed', async () => {
    const ctx = await setup();
    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/cancel`)
      .set(bearer(ctx.ownerToken))
      .send({ reason: 'Duplicate' })
      .expect(200);

    const res = await claim(ctx, ctx.agentA.accessToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_ALREADY_DONE');
    expect((await db.Order.findByPk(ctx.order.id)).confirmationState).toBe('rejected');
  });

  it('refuses an outcome on an order cancelled while the task was claimed', async () => {
    const ctx = await setup();
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await db.Order.update({ cancelledAt: new Date() }, { where: { id: ctx.order.id } });
    const res = await outcome(ctx, ctx.agentA.accessToken, { outcome: 'confirmed' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_CANCELLED');
  });
});

describe('release', () => {
  it('the holder releases their own claim back to Pending', async () => {
    const ctx = await setup();
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    const res = await release(ctx, ctx.agentA.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('queued');
    expect(res.body.task.lockedBy).toBeNull();
    const audit = await db.AuditLog.findOne({ where: { entityId: ctx.task.id, action: 'confirmation_task.release' } });
    expect(audit.metadata.forced).toBe(false);
  });

  it("another agent cannot release someone else's claim; a manager can", async () => {
    const ctx = await setup();
    await claim(ctx, ctx.agentA.accessToken).expect(200);

    const denied = await release(ctx, ctx.agentB.accessToken);
    expect(denied.status).toBe(403);
    expect((await db.ConfirmationTask.findByPk(ctx.task.id)).lockedByUserId).toBe(ctx.agentA.userId);

    const operator = await addMemberWithRole(ctx.ownerToken, ctx.workspace.id, 'order_operator', 'Operator Omar');
    const forced = await release(ctx, operator.accessToken);
    expect(forced.status).toBe(200);
    expect(forced.body.task.status).toBe('queued');
    const audit = await db.AuditLog.findOne({ where: { entityId: ctx.task.id, action: 'confirmation_task.release' } });
    expect(audit.actorUserId).toBe(operator.userId);
    expect(audit.metadata.forced).toBe(true);
  });

  it('refuses a task nobody holds, and a done one', async () => {
    const ctx = await setup();
    const free = await release(ctx, ctx.ownerToken);
    expect(free.status).toBe(409);
    expect(free.body.error.code).toBe('TASK_NOT_CLAIMED');

    await confirmCodOrder(ctx.ownerToken, ctx.workspace.id, ctx.order.id);
    const done = await release(ctx, ctx.ownerToken);
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe('TASK_ALREADY_DONE');
  });
});

describe('confirming from the order page', () => {
  it('confirms the order, closes the task and records an order-page attempt', async () => {
    const ctx = await setup();
    const before = await request(app)
      .get(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}`)
      .set(bearer(ctx.ownerToken));
    expect(before.body.order.confirmationTask).toEqual(
      expect.objectContaining({ id: ctx.task.id, status: 'queued', lockedBy: null, attemptCount: 0 })
    );

    const res = await confirmOnOrder(ctx, ctx.agentA.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.order.confirmationState).toBe('confirmed');
    expect(res.body.order.stage).toBe('ready_to_ship');
    expect(res.body.order.confirmationTask).toEqual(expect.objectContaining({ status: 'done', outcome: 'confirmed' }));
    expect(res.body.task.status).toBe('done');
    expect(res.body.task.attempts).toHaveLength(1);
    expect(res.body.task.attempts[0]).toEqual(
      expect.objectContaining({ outcome: 'confirmed', source: 'order_page', agent: { id: ctx.agentA.userId, fullName: 'Agent Amal' } })
    );

    const again = await confirmOnOrder(ctx, ctx.agentA.accessToken);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_ALREADY_CONFIRMED');
  });

  it('is refused while another agent holds a live lock, and allowed once it expires', async () => {
    const ctx = await setup();
    await claim(ctx, ctx.agentA.accessToken).expect(200);

    const order = await request(app)
      .get(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}`)
      .set(bearer(ctx.ownerToken));
    expect(order.body.order.confirmationTask.lockedBy).toEqual({ id: ctx.agentA.userId, fullName: 'Agent Amal' });
    expect(order.body.order.confirmationTask.lockExpiresAt).not.toBeNull();

    const blocked = await confirmOnOrder(ctx, ctx.agentB.accessToken);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TASK_ALREADY_LOCKED');
    expect(blocked.body.error.details.lockedBy.fullName).toBe('Agent Amal');

    // The holder themselves can confirm from the order page.
    await ageLock(ctx.task.id, env.confirmation.lockTtlMinutes + 1);
    const res = await confirmOnOrder(ctx, ctx.agentB.accessToken);
    expect(res.status).toBe(200);
  });

  it('needs orders.confirm, and only applies to open COD orders', async () => {
    const ctx = await setup();
    const operator = await addMemberWithRole(ctx.ownerToken, ctx.workspace.id, 'order_operator', 'Operator Omar');
    expect((await confirmOnOrder(ctx, operator.accessToken)).status).toBe(403);

    const card = await placeOrder(ctx.ownerToken, ctx.workspace.id, ctx.variant.id, { paymentMethod: 'card' });
    const notCod = await confirmOnOrder(ctx, ctx.ownerToken, card.id);
    expect(notCod.status).toBe(409);
    expect(notCod.body.error.code).toBe('ORDER_NOT_COD');

    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/cancel`)
      .set(bearer(ctx.ownerToken))
      .send({ reason: 'Duplicate' })
      .expect(200);
    const cancelled = await confirmOnOrder(ctx, ctx.ownerToken);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('ORDER_CANCELLED');
  });

  it('cancelling from the order page records who closed the task and why', async () => {
    const ctx = await setup();
    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/cancel`)
      .set(bearer(ctx.ownerToken))
      .send({ reason: 'Customer called to cancel' })
      .expect(200);
    const done = await list(ctx, ctx.ownerToken, '?status=done');
    expect(done.body.tasks).toHaveLength(1);
    expect(done.body.tasks[0].attempts[0]).toEqual(
      expect.objectContaining({ outcome: 'rejected', source: 'order_page', notes: 'Customer called to cancel' })
    );
    expect(done.body.tasks[0].completedAt).not.toBeNull();
    expect(done.body.tasks[0].correctable).toBe(false);
  });
});

describe('correcting an outcome', () => {
  async function confirmedCtx(opts) {
    const ctx = await setup(opts);
    await confirmCodOrder(ctx.ownerToken, ctx.workspace.id, ctx.order.id);
    return ctx;
  }

  it('confirmed → rejected releases stock once, counts a rejection and is audited', async () => {
    const ctx = await confirmedCtx({ quantity: 3 });
    expect((await variantOf(ctx)).reservedStock).toBe(3);

    const res = await correct(ctx, ctx.ownerToken, { outcome: 'rejected', reason: 'Customer called back to cancel' });
    expect(res.status).toBe(200);
    expect(res.body.task.outcome).toBe('rejected');
    expect(res.body.task.rejectionReason).toBe('Customer called back to cancel');
    const last = res.body.task.attempts[res.body.task.attempts.length - 1];
    expect(last).toEqual(expect.objectContaining({ source: 'correction', outcome: 'rejected', previousOutcome: 'confirmed' }));

    expect((await variantOf(ctx)).reservedStock).toBe(0);
    const order = await db.Order.findByPk(ctx.order.id);
    expect(order.confirmationState).toBe('rejected');
    expect(order.cancelledAt).toBeNull();
    expect((await db.Customer.findByPk(order.customerId)).totalRejectedOrders).toBe(1);

    const audit = await db.AuditLog.findOne({ where: { entityId: ctx.task.id, action: 'confirmation_task.correct' } });
    expect(audit.beforeState).toEqual({ outcome: 'confirmed' });
    expect(audit.afterState).toEqual({ outcome: 'rejected' });
    expect(audit.metadata.reason).toBe('Customer called back to cancel');

    const same = await correct(ctx, ctx.ownerToken, { outcome: 'rejected', reason: 'Twice' });
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('OUTCOME_UNCHANGED');
  });

  it('cancels a created manual shipment when correcting to rejected', async () => {
    const ctx = await confirmedCtx();
    const ship = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments`)
      .set(bearer(ctx.ownerToken))
      .send({ carrierCode: 'local-courier' });
    expect(ship.status).toBe(201);
    await correct(ctx, ctx.ownerToken, { outcome: 'rejected', reason: 'Changed mind' }).expect(200);
    expect((await db.Shipment.findByPk(ship.body.shipment.id)).status).toBe('cancelled');
  });

  it('rejected → confirmed re-reserves stock and uncounts the rejection', async () => {
    const ctx = await setup({ quantity: 2 });
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await outcome(ctx, ctx.agentA.accessToken, { outcome: 'rejected', rejectionReason: 'Misunderstanding' }).expect(200);
    expect((await variantOf(ctx)).reservedStock).toBe(0);

    const res = await correct(ctx, ctx.ownerToken, { outcome: 'confirmed', reason: 'Customer called back, still wants it' });
    expect(res.status).toBe(200);
    expect(res.body.task.outcome).toBe('confirmed');
    expect(res.body.task.rejectionReason).toBeNull();
    expect((await variantOf(ctx)).reservedStock).toBe(2);
    const order = await db.Order.findByPk(ctx.order.id);
    expect(order.confirmationState).toBe('confirmed');
    expect((await db.Customer.findByPk(order.customerId)).totalRejectedOrders).toBe(0);
    expect(
      await db.InventoryMovement.count({ where: { referenceId: ctx.order.id, type: 'reserve', referenceType: 'order_reconfirmed' } })
    ).toBe(1);
  });

  it('rejected → confirmed answers 409 INSUFFICIENT_STOCK when the stock is gone, and changes nothing', async () => {
    const ctx = await setup({ stock: 2, quantity: 2 });
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await outcome(ctx, ctx.agentA.accessToken, { outcome: 'rejected', rejectionReason: 'No' }).expect(200);
    // Someone else buys the freed units.
    await placeOrder(ctx.ownerToken, ctx.workspace.id, ctx.variant.id, { quantity: 2, phone: '01000004444' });

    const res = await correct(ctx, ctx.ownerToken, { outcome: 'confirmed', reason: 'Changed back' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await db.Order.findByPk(ctx.order.id)).confirmationState).toBe('rejected');
    expect((await db.ConfirmationTask.findByPk(ctx.task.id)).outcome).toBe('rejected');
  });

  it('a merchant cancellation cannot be corrected back to confirmed', async () => {
    const ctx = await setup();
    await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/cancel`)
      .set(bearer(ctx.ownerToken))
      .send({ reason: 'Duplicate' })
      .expect(200);
    const res = await correct(ctx, ctx.ownerToken, { outcome: 'confirmed', reason: 'Oops' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORRECTION_NOT_ALLOWED');
  });

  it('is refused once the order has shipped, and the Done tab says so', async () => {
    const ctx = await confirmedCtx();
    const ship = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments`)
      .set(bearer(ctx.ownerToken))
      .send({ carrierCode: 'local-courier' });
    await request(app)
      .patch(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments/${ship.body.shipment.id}`)
      .set(bearer(ctx.ownerToken))
      .send({ status: 'picked_up' })
      .expect(200);

    const done = await list(ctx, ctx.ownerToken, '?status=done');
    expect(done.body.tasks[0].correctable).toBe(false);

    const res = await correct(ctx, ctx.ownerToken, { outcome: 'rejected', reason: 'Too late' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_ALREADY_SHIPPED');
  });

  it('needs orders.manage, a reason, and a finished task', async () => {
    const ctx = await setup();
    const open = await correct(ctx, ctx.ownerToken, { outcome: 'confirmed', reason: 'Early' });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe('TASK_NOT_DONE');

    await confirmCodOrder(ctx.ownerToken, ctx.workspace.id, ctx.order.id);
    expect((await correct(ctx, ctx.agentA.accessToken, { outcome: 'rejected', reason: 'x' })).status).toBe(403);
    expect((await correct(ctx, ctx.ownerToken, { outcome: 'rejected' })).status).toBe(422);
    expect((await correct(ctx, ctx.ownerToken, { outcome: 'postponed', reason: 'x' })).status).toBe(422);

    const operator = await addMemberWithRole(ctx.ownerToken, ctx.workspace.id, 'order_operator', 'Operator Omar');
    const byManager = await correct(ctx, operator.accessToken, { outcome: 'rejected', reason: 'Customer cancelled by SMS' });
    expect(byManager.status).toBe(200);
  });
});

describe('queue tabs and counts', () => {
  it('lists Pending, In progress (mine first) and Done, with counts', async () => {
    const ctx = await setup();
    const token = ctx.ownerToken;
    const o2 = await placeOrder(token, ctx.workspace.id, ctx.variant.id, { phone: '01000005555' });
    const o3 = await placeOrder(token, ctx.workspace.id, ctx.variant.id, { phone: '01000006666' });
    const o4 = await placeOrder(token, ctx.workspace.id, ctx.variant.id, { phone: '01000007777' });
    const taskOf = async (orderId) => (await db.ConfirmationTask.findOne({ where: { orderId } })).id;
    const [t2, t3, t4] = [await taskOf(o2.id), await taskOf(o3.id), await taskOf(o4.id)];

    // B claims t2 first, then A claims t3: A sees their own first anyway.
    await claim(ctx, ctx.agentB.accessToken, t2).expect(200);
    await claim(ctx, ctx.agentA.accessToken, t3).expect(200);
    // t4 is done; ctx.task stays pending.
    await confirmCodOrder(token, ctx.workspace.id, o4.id);

    const pending = await list(ctx, ctx.agentA.accessToken, '?status=pending');
    expect(pending.body.tasks.map((t) => t.id)).toEqual([ctx.task.id]);
    // The old name still works.
    const legacy = await list(ctx, ctx.agentA.accessToken, '?status=queued&limit=200');
    expect(legacy.body.tasks.map((t) => t.id)).toEqual([ctx.task.id]);

    const inProgress = await list(ctx, ctx.agentA.accessToken, '?status=in_progress');
    expect(inProgress.body.tasks.map((t) => t.id)).toEqual([t3, t2]);
    expect(inProgress.body.tasks[1].lockedBy.fullName).toBe('Agent Bassem');
    expect(inProgress.body.tasks[1].lockExpiresAt).not.toBeNull();

    const mine = await list(ctx, ctx.agentA.accessToken, '?status=in_progress&mine=true');
    expect(mine.body.tasks.map((t) => t.id)).toEqual([t3]);

    const done = await list(ctx, ctx.agentA.accessToken, '?status=done');
    expect(done.body.tasks.map((t) => t.id)).toEqual([t4]);
    expect(done.body.tasks[0].correctable).toBe(true);
    expect(done.body.tasks[0].attempts[0].agent.id).toBe(ctx.auth.userId);
    expect((await list(ctx, ctx.agentA.accessToken, '?status=done&mine=true')).body.tasks).toHaveLength(0);

    const c = await counts(ctx, ctx.agentA.accessToken);
    expect(c.status).toBe(200);
    expect(c.body.counts).toEqual({ pending: 1, pendingDue: 1, inProgress: 2, inProgressMine: 1, done: 1 });
  });

  it('pages with a cursor, due callbacks before later ones', async () => {
    const ctx = await setup({ stock: 50 });
    const token = ctx.ownerToken;
    for (let i = 0; i < 4; i++) {
      await placeOrder(token, ctx.workspace.id, ctx.variant.id, { quantity: 1, phone: `0100000800${i}` });
    }
    // The first task was postponed: its callback is tomorrow, so it sorts last.
    await claim(ctx, ctx.agentA.accessToken).expect(200);
    await outcome(ctx, ctx.agentA.accessToken, { outcome: 'postponed' }).expect(200);

    const seen = [];
    let cursor = null;
    do {
      const res = await list(ctx, token, `?status=pending&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.tasks.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.tasks.map((t) => t.id));
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen[seen.length - 1]).toBe(ctx.task.id);

    const c = await counts(ctx, token);
    expect(c.body.counts.pending).toBe(5);
    expect(c.body.counts.pendingDue).toBe(4);

    const bad = await list(ctx, token, '?status=pending&cursor=00000000-0000-4000-8000-000000000000');
    expect(bad.status).toBe(422);
  });

  it('managers without orders.confirm can read the queue but not claim', async () => {
    const ctx = await setup();
    const operator = await addMemberWithRole(ctx.ownerToken, ctx.workspace.id, 'order_operator', 'Operator Omar');
    expect((await list(ctx, operator.accessToken)).status).toBe(200);
    expect((await counts(ctx, operator.accessToken)).status).toBe(200);
    expect((await claim(ctx, operator.accessToken)).status).toBe(403);

    const editor = await addMemberWithRole(ctx.ownerToken, ctx.workspace.id, 'editor', 'Editor Eman');
    expect((await list(ctx, editor.accessToken)).status).toBe(403);
  });

  it("never reaches another workspace's tasks", async () => {
    const A = await setup();
    const B = await setupWorkspaceWithProduct();
    const asB = (method, url) => request(app)[method](url).set(bearer(B.auth.accessToken)).send({});
    await confirmCodOrder(A.ownerToken, A.workspace.id, A.order.id);

    expect((await asB('get', `${A.base}/counts`)).status).toBe(404);
    expect((await asB('post', `${A.base}/${A.task.id}/release`)).status).toBe(404);
    expect((await asB('post', `${A.base}/${A.task.id}/correction`)).status).toBe(404);
    expect((await asB('post', `/api/v1/workspaces/${A.workspace.id}/orders/${A.order.id}/confirmation`)).status).toBe(404);

    // B's own workspace URL with A's task id: not found, not A's task.
    const own = `/api/v1/workspaces/${B.workspace.id}/confirmation-tasks/${A.task.id}`;
    expect(
      (await request(app).post(`${own}/correction`).set(bearer(B.auth.accessToken)).send({ outcome: 'rejected', reason: 'x' })).status
    ).toBe(404);
    expect((await request(app).post(`${own}/claim`).set(bearer(B.auth.accessToken)).send({})).status).toBe(404);
  });
});

describe('manual shipments', () => {
  it('refuses a manual shipment on an unconfirmed COD order, the same way as a courier booking', async () => {
    const ctx = await setup();
    const url = `/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.order.id}/shipments`;
    const res = await request(app).post(url).set(bearer(ctx.ownerToken)).send({ carrierCode: 'local-courier' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_CONFIRMED');
    expect(await db.Shipment.count({ where: { orderId: ctx.order.id } })).toBe(0);

    await confirmCodOrder(ctx.ownerToken, ctx.workspace.id, ctx.order.id);
    expect((await request(app).post(url).set(bearer(ctx.ownerToken)).send({ carrierCode: 'local-courier' })).status).toBe(201);
  });

  it('refuses an unpaid prepaid order with ORDER_NOT_PAID', async () => {
    const ctx = await setup();
    const card = await placeOrder(ctx.ownerToken, ctx.workspace.id, ctx.variant.id, { paymentMethod: 'card' });
    const res = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${card.id}/shipments`)
      .set(bearer(ctx.ownerToken))
      .send({ carrierCode: 'local-courier' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_PAID');
  });
});
