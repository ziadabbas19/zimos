'use strict';

// Returns on the ReturnRequest model: open only on a delivered order with a
// coded reason, approve/reject moderation, and a separate manual restock
// step (approval never moves stock).

const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function placeOrder(token, workspaceId, variantId, qty = 3) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `r-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: qty }],
      contact: { fullName: 'Return Buyer', phone: '01000003333' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '3 C St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function markDelivered(token, workspaceId, orderId) {
  const ship = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments`)
    .set(bearer(token))
    .send({ carrierCode: 'bosta' });
  await request(app)
    .patch(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/shipments/${ship.body.shipment.id}`)
    .set(bearer(token))
    .send({ status: 'delivered' })
    .expect(200);
}

async function openReturn(token, workspaceId, orderId, overrides = {}) {
  const item = await db.OrderItem.findOne({ where: { orderId } });
  return request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/returns`)
    .set(bearer(token))
    .send({
      reasonCode: 'damaged',
      items: [{ orderItemId: item.id, quantity: 2 }],
      ...overrides,
    });
}

describe('opening a return', () => {
  it('is refused until the order is delivered', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const res = await openReturn(auth.accessToken, workspace.id, order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_DELIVERED');
  });

  it('succeeds on a delivered order with a coded reason, starting in "requested"', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);

    const res = await openReturn(auth.accessToken, workspace.id, order.id, { reasonCode: 'wrong_item', reasonDetail: 'sent blue not red' });
    expect(res.status).toBe(201);
    expect(res.body.return.status).toBe('requested');
    expect(res.body.return.reason).toBe('wrong_item: sent blue not red');
  });

  it('rejects an unknown reason code and an over-quantity / foreign line item', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 2);
    await markDelivered(auth.accessToken, workspace.id, order.id);

    expect((await openReturn(auth.accessToken, workspace.id, order.id, { reasonCode: 'because' })).status).toBe(422);

    const item = await db.OrderItem.findOne({ where: { orderId: order.id } });
    const over = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/returns`)
      .set(bearer(auth.accessToken))
      .send({ reasonCode: 'damaged', items: [{ orderItemId: item.id, quantity: 5 }] });
    expect(over.status).toBe(422);

    const foreign = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/returns`)
      .set(bearer(auth.accessToken))
      .send({ reasonCode: 'damaged', items: [{ orderItemId: order.id, quantity: 1 }] });
    expect(foreign.status).toBe(422);
  });
});

describe('listing returns', () => {
  it('lists per-order and workspace-wide, filterable by status', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 20 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    const created = await openReturn(auth.accessToken, workspace.id, order.id);
    expect(created.status).toBe(201);

    const perOrder = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/returns`)
      .set(bearer(auth.accessToken));
    expect(perOrder.status).toBe(200);
    expect(perOrder.body.returns).toHaveLength(1);

    const all = await request(app).get(`/api/v1/workspaces/${workspace.id}/returns`).set(bearer(auth.accessToken));
    expect(all.body.returns).toHaveLength(1);

    const filtered = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/returns?status=approved`)
      .set(bearer(auth.accessToken));
    expect(filtered.body.returns).toHaveLength(0);
  });
});

describe('moderation + separate restock', () => {
  it('approves without touching stock, then restocks only on the explicit call', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 3);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    // deliver commits none of our stock in this flow; capture the baseline now
    const stockBefore = (await db.ProductVariant.findByPk(variant.id)).stockOnHand;

    const ret = (await openReturn(auth.accessToken, workspace.id, order.id, { items: [{ orderItemId: (await db.OrderItem.findOne({ where: { orderId: order.id } })).id, quantity: 2 }] })).body.return;

    const approve = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/returns/${ret.id}`)
      .set(bearer(auth.accessToken))
      .send({ action: 'approve' });
    expect(approve.status).toBe(200);
    expect(approve.body.return.status).toBe('approved');

    // NO auto-restock
    expect((await db.ProductVariant.findByPk(variant.id)).stockOnHand).toBe(stockBefore);

    // approving again is refused
    const again = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/returns/${ret.id}`)
      .set(bearer(auth.accessToken))
      .send({ action: 'approve' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('RETURN_NOT_PENDING');

    // explicit restock
    const restock = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/returns/${ret.id}/restock`)
      .set(bearer(auth.accessToken));
    expect(restock.status).toBe(200);
    expect(restock.body.return.status).toBe('received');
    expect(restock.body.return.restockedAt).not.toBeNull();
    expect((await db.ProductVariant.findByPk(variant.id)).stockOnHand).toBe(stockBefore + 2);

    // a return_restock inventory movement was written
    const move = await db.InventoryMovement.findOne({ where: { variantId: variant.id, type: 'return_restock' } });
    expect(move).not.toBeNull();

    // restocking twice is refused
    const twice = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/returns/${ret.id}/restock`)
      .set(bearer(auth.accessToken));
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('RETURN_ALREADY_RESTOCKED');
  });

  it('a rejected return cannot be restocked', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    await markDelivered(auth.accessToken, workspace.id, order.id);
    const ret = (await openReturn(auth.accessToken, workspace.id, order.id)).body.return;

    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/returns/${ret.id}`)
      .set(bearer(auth.accessToken))
      .send({ action: 'reject' })
      .expect(200);

    const restock = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/returns/${ret.id}/restock`)
      .set(bearer(auth.accessToken));
    expect(restock.status).toBe(409);
    expect(restock.body.error.code).toBe('RETURN_NOT_APPROVED');
  });
});

describe('cross-workspace', () => {
  it('refuses return actions on another workspace order (404)', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'P3 A', stock: 10 });
    const orderA = await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id);
    await markDelivered(A.auth.accessToken, A.workspace.id, orderA.id);
    const retA = (await openReturn(A.auth.accessToken, A.workspace.id, orderA.id)).body.return;

    const B = await registerAndActivate({ fullName: 'P3 B' });
    await createWorkspace(B.accessToken, 'P3 B WS');
    const asB = (m, p, body) => request(app)[m](p).set(bearer(B.accessToken)).send(body || {});

    expect((await asB('get', `/api/v1/workspaces/${A.workspace.id}/orders/${orderA.id}/returns`)).status).toBe(404);
    expect((await asB('patch', `/api/v1/workspaces/${A.workspace.id}/returns/${retA.id}`, { action: 'approve' })).status).toBe(404);
    expect((await asB('post', `/api/v1/workspaces/${A.workspace.id}/returns/${retA.id}/restock`)).status).toBe(404);
  });
});
