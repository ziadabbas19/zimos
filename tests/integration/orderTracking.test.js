'use strict';

// GET /api/v1/store/:workspaceId/orders/track — the public shopper lookup.
// Orders are created through the real checkout endpoint; shipments and
// confirmation state are then advanced directly, since this endpoint only
// reads them and the staff routes that write them are covered elsewhere.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');

const RAW_PHONE = '01055551234';
const NORMALIZED_PHONE = '201055551234';

const track = (workspaceRef, query) => request(app).get(`/api/v1/store/${workspaceRef}/orders/track`).query(query);

/** One COD order for RAW_PHONE, placed through the storefront checkout. */
async function placeOrder({ price = 15000, quantity = 2 } = {}) {
  const { workspace, variant } = await setupWorkspaceWithProduct({ price, stock: 50 });

  const res = await request(app)
    .post(`/api/v1/store/${workspace.id}/checkout`)
    .set('Idempotency-Key', `track-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId: variant.id, quantity },
      contact: { fullName: 'Tracking Shopper', phone: RAW_PHONE },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '5 Track St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { workspace, variant, order: res.body.order };
}

const addShipment = (workspace, order, fields) =>
  db.Shipment.create({
    workspaceId: workspace.id,
    orderId: order.id,
    trackingCode: `zg${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
    carrierCode: 'manual',
    ...fields,
  });

describe('public order tracking', () => {
  it('returns the full tracking shape for a found order', async () => {
    const { workspace, order } = await placeOrder({ price: 15000, quantity: 2 });

    const res = await track(workspace.id, { phone: NORMALIZED_PHONE, number: order.orderNumber });

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      orderNumber: order.orderNumber,
      stage: 0,
      subtotalAmount: '30000',
      discountAmount: '0',
      totalAmount: String(order.totalAmount),
      currency: 'EGP',
    });
    expect(res.body.result.items).toEqual([
      { productNameSnapshot: 'Test Product', quantity: 2, lineTotalAmount: '30000' },
    ]);
    expect(typeof res.body.result.shippingAmount).toBe('string');
    expect(new Date(res.body.result.updatedAt).toString()).not.toBe('Invalid Date');

    // nothing beyond the tracking shape reaches the shopper
    expect(Object.keys(res.body.result).sort()).toEqual([
      'currency',
      'discountAmount',
      'items',
      'orderNumber',
      'shippingAmount',
      'stage',
      'subtotalAmount',
      'totalAmount',
      'updatedAt',
    ]);
  });

  it('accepts the phone in either local or country-code form', async () => {
    const { workspace, order } = await placeOrder();

    for (const phone of [RAW_PHONE, NORMALIZED_PHONE]) {
      const res = await track(workspace.id, { phone, number: order.orderNumber });
      expect(res.status).toBe(200);
      expect(res.body.result.orderNumber).toBe(order.orderNumber);
    }
  });

  it('matches the order number case-insensitively, and resolves the store by slug', async () => {
    const { workspace, order } = await placeOrder();

    const res = await track(workspace.slug, { phone: NORMALIZED_PHONE, number: order.orderNumber.toLowerCase() });
    expect(res.status).toBe(200);
    expect(res.body.result.orderNumber).toBe(order.orderNumber);
  });

  it('advances the stage through confirmation, shipping and delivery', async () => {
    const { workspace, order } = await placeOrder();
    const lookup = () => track(workspace.id, { phone: NORMALIZED_PHONE, number: order.orderNumber });

    expect((await lookup()).body.result.stage).toBe(0);

    await db.Order.update({ confirmationState: 'confirmed' }, { where: { id: order.id } });
    expect((await lookup()).body.result.stage).toBe(1);

    // a waybill that exists but hasn't moved is still stage 1
    const shipment = await addShipment(workspace, order, { status: 'created' });
    expect((await lookup()).body.result.stage).toBe(1);

    const shippedAt = new Date('2026-09-01T10:00:00.000Z');
    await shipment.update({ status: 'in_transit', shippedAt });
    const shipped = await lookup();
    expect(shipped.body.result.stage).toBe(2);
    expect(shipped.body.result.updatedAt).toBe(shippedAt.toISOString());

    const deliveredAt = new Date('2026-09-03T14:30:00.000Z');
    await shipment.update({ status: 'delivered', deliveredAt });
    const delivered = await lookup();
    expect(delivered.body.result.stage).toBe(3);
    expect(delivered.body.result.updatedAt).toBe(deliveredAt.toISOString());
  });

  it('reports the furthest stage when an order ships in more than one parcel', async () => {
    const { workspace, order } = await placeOrder();
    await addShipment(workspace, order, { status: 'in_transit', shippedAt: new Date() });
    await addShipment(workspace, order, { status: 'delivered', deliveredAt: new Date('2026-09-04T09:00:00.000Z') });

    const res = await track(workspace.id, { phone: NORMALIZED_PHONE, number: order.orderNumber });
    expect(res.body.result.stage).toBe(3);
    expect(res.body.result.updatedAt).toBe('2026-09-04T09:00:00.000Z');
  });

  it('falls back to the order timestamp when the carrier gave no shipped date', async () => {
    const { workspace, order } = await placeOrder();
    await addShipment(workspace, order, { status: 'out_for_delivery', shippedAt: null });

    const res = await track(workspace.id, { phone: NORMALIZED_PHONE, number: order.orderNumber });
    expect(res.body.result.stage).toBe(2);
    expect(res.body.result.updatedAt).not.toBeNull();
  });

  it('answers 200 { result: null } for a wrong phone or an unknown order number', async () => {
    const { workspace, order } = await placeOrder();

    const wrongPhone = await track(workspace.id, { phone: '201999999999', number: order.orderNumber });
    expect(wrongPhone.status).toBe(200);
    expect(wrongPhone.body).toEqual({ result: null });

    const unknownNumber = await track(workspace.id, { phone: NORMALIZED_PHONE, number: 'ORD-NOPE-0000' });
    expect(unknownNumber.status).toBe(200);
    expect(unknownNumber.body).toEqual({ result: null });
  });

  it('will not return an order to a phone that did not place it', async () => {
    const { workspace, variant } = await placeOrder();

    // a second shopper in the same store
    const other = await request(app)
      .post(`/api/v1/store/${workspace.id}/checkout`)
      .set('Idempotency-Key', `track-other-${Date.now()}`)
      .send({
        item: { variantId: variant.id, quantity: 1 },
        contact: { fullName: 'Someone Else', phone: '01122223333' },
        shippingAddress: { country: 'EG', city: 'Giza', addressLine: '9 Other St' },
        paymentMethod: 'cod',
      });
    expect(other.status).toBe(201);

    const res = await track(workspace.id, { phone: NORMALIZED_PHONE, number: other.body.order.orderNumber });
    expect(res.body).toEqual({ result: null });
  });

  it('is scoped to one workspace', async () => {
    const { order } = await placeOrder();
    const { workspace: otherStore } = await setupWorkspaceWithProduct();

    const res = await track(otherStore.id, { phone: NORMALIZED_PHONE, number: order.orderNumber });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ result: null });
  });

  // 422 VALIDATION_ERROR, not 400: that's what `validate` raises everywhere
  // else in this API, and the tracker should read it the same way.
  it('rejects a malformed phone or order number', async () => {
    const { workspace, order } = await placeOrder();

    const cases = [
      { phone: '+20 100 555 1234', number: order.orderNumber }, // not digits-only
      { phone: '2010', number: order.orderNumber }, // too short
      { phone: NORMALIZED_PHONE, number: 'AB' }, // too short
      { phone: NORMALIZED_PHONE, number: 'ORD_123' }, // underscore not allowed
      { phone: NORMALIZED_PHONE }, // number missing
      { number: order.orderNumber }, // phone missing
    ];

    for (const query of cases) {
      const res = await track(workspace.id, query);
      expect({ query, status: res.status }).toEqual({ query, status: 422 });
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});
