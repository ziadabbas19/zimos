'use strict';

// The response shape the dashboard's confirmation queue renders from: every
// task carries its order *with the order's items*, on the list and on the
// claim/outcome responses alike. The list used to include the order without
// its items, which blanked the page on the first real COD order.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function placeStorefrontCodOrder(workspaceId, variantId) {
  const res = await request(app)
    .post(`/api/v1/store/${workspaceId}/checkout`)
    .set('Idempotency-Key', `cq-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId, quantity: 2 },
      contact: { fullName: 'Queue Buyer', phone: '01055554321' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Queue St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

function expectTaskWithOrderItems(task, order, variantId) {
  expect(task.orderId).toBe(order.id);
  expect(task.order).toBeDefined();
  expect(task.order.id).toBe(order.id);
  expect(task.order.contactSnapshot).toEqual(expect.objectContaining({ fullName: 'Queue Buyer', phone: '01055554321' }));
  expect(Array.isArray(task.order.riskFlags)).toBe(true);
  expect(Array.isArray(task.order.items)).toBe(true);
  expect(task.order.items).toHaveLength(1);
  expect(task.order.items[0]).toEqual(expect.objectContaining({ variantId, quantity: 2 }));
}

describe('confirmation queue response shape', () => {
  it('returns each task with its order and the order items on list, claim and outcome', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeStorefrontCodOrder(workspace.id, variant.id);
    const base = `/api/v1/workspaces/${workspace.id}/confirmation-tasks`;

    const list = await request(app).get(`${base}?status=queued&limit=200`).set(bearer(auth.accessToken));
    expect(list.status).toBe(200);
    expect(list.body.tasks).toHaveLength(1);
    const [task] = list.body.tasks;
    expect(task.status).toBe('queued');
    expect(task.attemptCount).toBe(0);
    expectTaskWithOrderItems(task, order, variant.id);

    const claim = await request(app).post(`${base}/${task.id}/claim`).set(bearer(auth.accessToken)).send({});
    expect(claim.status).toBe(200);
    expect(claim.body.task.status).toBe('in_progress');
    expect(claim.body.task.lockedByUserId).toBe(auth.userId);
    expectTaskWithOrderItems(claim.body.task, order, variant.id);

    const outcome = await request(app)
      .post(`${base}/${task.id}/outcome`)
      .set(bearer(auth.accessToken))
      .send({ outcome: 'postponed' });
    expect(outcome.status).toBe(200);
    expect(outcome.body.task.status).toBe('queued');
    expect(outcome.body.task.attemptCount).toBe(1);
    expectTaskWithOrderItems(outcome.body.task, order, variant.id);
  });
});
