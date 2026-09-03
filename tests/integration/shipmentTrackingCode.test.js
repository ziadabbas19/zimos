'use strict';

// Every Shipment carries a human-facing `trackingCode` (`zg` + 9 digits),
// distinct from the UUID PK, unique, generated with a collision-retry loop.
// It's what shows on the waybill and shipment responses.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const orderService = require('../../src/modules/orders/orderService');
const waybillService = require('../../src/modules/waybill/waybillService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const PATTERN = /^zg\d{9}$/;

async function placeOrder(token, workspaceId, variantId, i = 0) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `tc-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: `TC Buyer ${i}`, phone: `0100000${5000 + i}` },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: 'x' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

describe('shipment tracking code', () => {
  it('generateTrackingCode always matches zg + 9 digits', () => {
    for (let i = 0; i < 2000; i++) {
      expect(orderService.generateTrackingCode()).toMatch(PATTERN);
    }
  });

  it('a created shipment gets a trackingCode distinct from its id', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'bosta' });
    expect(res.status).toBe(201);
    expect(res.body.shipment.trackingCode).toMatch(PATTERN);
    expect(res.body.shipment.trackingCode).not.toBe(res.body.shipment.id);

    // update response still carries it
    const upd = await request(app)
      .patch(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments/${res.body.shipment.id}`)
      .set(bearer(auth.accessToken))
      .send({ status: 'in_transit' });
    expect(upd.body.shipment.trackingCode).toBe(res.body.shipment.trackingCode);
  });

  it('codes stay unique and well-formed under concurrent shipment creation', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 30 });

    const orders = [];
    for (let i = 0; i < 20; i++) orders.push(await placeOrder(auth.accessToken, workspace.id, variant.id, i));

    const results = await Promise.all(
      orders.map((o) =>
        request(app)
          .post(`/api/v1/workspaces/${workspace.id}/orders/${o.id}/shipments`)
          .set(bearer(auth.accessToken))
          .send({ carrierCode: 'bosta' })
      )
    );

    expect(results.every((r) => r.status === 201)).toBe(true);
    const codes = results.map((r) => r.body.shipment.trackingCode);
    expect(codes.every((c) => PATTERN.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length); // all distinct

    // the DB unique index agrees
    const rows = await db.Shipment.findAll({ where: { workspaceId: workspace.id }, attributes: ['trackingCode'] });
    expect(new Set(rows.map((r) => r.trackingCode)).size).toBe(rows.length);
  });

  it('the waybill uses the shipment trackingCode once a shipment exists', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    // before a shipment: falls back to the order number
    let model = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(model.trackingValue).toBe(order.orderNumber);

    const ship = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/shipments`)
      .set(bearer(auth.accessToken))
      .send({ carrierCode: 'bosta' });

    model = await waybillService.computeWaybillModel(workspace.id, order.id);
    expect(model.trackingValue).toBe(ship.body.shipment.trackingCode);
    expect(model.trackingValue).toMatch(PATTERN);
  });
});
