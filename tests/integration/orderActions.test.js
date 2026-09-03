'use strict';

// Direct merchant order actions: cancel (with inventory release and a
// "too late once shipped" guard), a narrow PATCH (address + notes only),
// and manual shipment create / status update.

const { app, request, setupWorkspaceWithProduct, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function placeOrder(token, workspaceId, variantId, qty = 2) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `o-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: qty }],
      contact: { fullName: 'Order Two Buyer', phone: '01000002222' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

describe('cancel order', () => {
  it('releases the inventory reservation, records the reason, and marks the order rejected', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 3);

    const reserved = (await db.ProductVariant.findByPk(variant.id)).reservedStock;
    expect(reserved).toBe(3);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/cancel`)
      .set(bearer(auth.accessToken))
      .send({ reason: 'Customer changed their mind' });
    expect(res.status).toBe(200);

    const v = await db.ProductVariant.findByPk(variant.id);
    expect(v.reservedStock).toBe(0); // released
    expect(v.stockOnHand).toBe(10); // never deducted — nothing shipped

    const o = await db.Order.findByPk(order.id);
    expect(o.cancelledAt).not.toBeNull();
    expect(o.cancellationReason).toBe('Customer changed their mind');
    expect(o.confirmationState).toBe('rejected');

    // an audit row was written
    const audit = await db.AuditLog.findOne({ where: { entityType: 'Order', entityId: order.id, action: 'order.cancel' } });
    expect(audit).not.toBeNull();

    // the release shows up as an inventory movement
    const move = await db.InventoryMovement.findOne({ where: { variantId: variant.id, type: 'release', referenceType: 'order_cancelled' } });
    expect(move).not.toBeNull();
  });

  it('closes any open confirmation task for the order', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 1);
    expect(await db.ConfirmationTask.count({ where: { orderId: order.id, status: 'queued' } })).toBe(1);

    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/cancel`)
      .set(bearer(auth.accessToken))
      .send({ reason: 'Duplicate order' })
      .expect(200);

    expect(await db.ConfirmationTask.count({ where: { orderId: order.id, status: 'queued' } })).toBe(0);
    const task = await db.ConfirmationTask.findOne({ where: { orderId: order.id } });
    expect(task.status).toBe('done');
    expect(task.outcome).toBe('rejected');
  });

  it('refuses to cancel once a shipment is in transit', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 1);

    const ship = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'bosta' });
    expect(ship.status).toBe(201);

    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments/${ship.body.shipment.id}`)
      .set(bearer(auth.accessToken))
      .send({ status: 'in_transit' })
      .expect(200);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/cancel`)
      .set(bearer(auth.accessToken))
      .send({ reason: 'Too late' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_ALREADY_SHIPPED');
  });

  it('refuses a second cancellation', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 1);
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/cancel`)
      .set(bearer(auth.accessToken))
      .send({ reason: 'first' })
      .expect(200);
    const again = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/cancel`)
      .set(bearer(auth.accessToken))
      .send({ reason: 'second' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_ALREADY_CANCELLED');
  });
});

describe('limited PATCH /orders/:orderId', () => {
  it('updates only the shipping address and notes, never totals or items', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5, price: 10000 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 2);
    const totalBefore = String(order.totalAmount);
    const itemsBefore = await db.OrderItem.count({ where: { orderId: order.id } });

    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}`)
      .set(bearer(auth.accessToken))
      .send({
        shippingAddress: { country: 'EG', city: 'Alexandria', addressLine: '99 Corniche' },
        notes: 'Leave with the doorman',
        totalAmount: 1, // must be ignored/stripped
        items: [], // must be ignored/stripped
      });
    expect(res.status).toBe(200);

    const o = await db.Order.findByPk(order.id);
    expect(o.shippingAddressSnapshot.city).toBe('Alexandria');
    expect(o.notes).toBe('Leave with the doorman');
    expect(String(o.totalAmount)).toBe(totalBefore); // unchanged
    expect(await db.OrderItem.count({ where: { orderId: order.id } })).toBe(itemsBefore); // unchanged
  });

  it('rejects a body that only contains disallowed fields (422)', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 1);
    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}`)
      .set(bearer(auth.accessToken))
      .send({ totalAmount: 5, subtotalAmount: 5 });
    expect(res.status).toBe(422);
  });

  it('refuses edits once the order has shipped', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 1);
    const ship = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'bosta' });
    await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments/${ship.body.shipment.id}`)
      .set(bearer(auth.accessToken))
      .send({ status: 'picked_up' })
      .expect(200);

    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}`)
      .set(bearer(auth.accessToken))
      .send({ notes: 'too late' });
    expect(res.status).toBe(409);
  });
});

describe('shipments', () => {
  it('creates a shipment in status "created" and updates its status manually', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, 1);

    const create = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'bosta', waybillNumber: 'WB-123' });
    expect(create.status).toBe(201);
    expect(create.body.shipment.status).toBe('created');
    expect(create.body.shipment.carrierCode).toBe('bosta');

    const list = await request(app)
      .get(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken));
    expect(list.body.shipments).toHaveLength(1);

    const upd = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments/${create.body.shipment.id}`)
      .set(bearer(auth.accessToken))
      .send({ status: 'delivered' });
    expect(upd.status).toBe(200);
    expect(upd.body.shipment.status).toBe('delivered');
    expect(upd.body.shipment.deliveredAt).not.toBeNull();

    const o = await db.Order.findByPk(order.id);
    expect(o.fulfillmentState).toBe('fulfilled');
  });
});

describe('cross-workspace', () => {
  it('refuses cancel / patch / shipment actions on another workspace order (404)', async () => {
    const A = await setupWorkspaceWithProduct({ workspaceName: 'P2 A' });
    const orderA = await placeOrder(A.auth.accessToken, A.workspace.id, A.variant.id, 1);
    const B = await registerAndActivate({ fullName: 'P2 B' });
    await createWorkspace(B.accessToken, 'P2 B WS');

    const asB = (m, p, body) => request(app)[m](p).set(bearer(B.accessToken)).send(body || {});
    expect((await asB('post', `/api/v1/workspaces/${A.workspace.id}/orders/${orderA.id}/cancel`, { reason: 'x' })).status).toBe(404);
    expect((await asB('patch', `/api/v1/workspaces/${A.workspace.id}/orders/${orderA.id}`, { notes: 'x' })).status).toBe(404);
    expect((await asB('post', `/api/v1/workspaces/${A.workspace.id}/orders/${orderA.id}/shipments`, { carrierCode: 'x' })).status).toBe(404);

    expect((await db.Order.findByPk(orderA.id)).cancelledAt).toBeNull();
  });
});
