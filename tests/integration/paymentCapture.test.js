'use strict';

// Payment capture safety: a capture is idempotent (a double-clicked button
// must not credit the order twice), only an authorized payment is capturable,
// and amountPaid can never run past the order total. Plus the "no fake online
// payments" guards: the public checkout is COD-only, and production refuses
// to initialize a non-COD payment while no real gateway is configured.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let phoneSeq = 0;
const nextPhone = () => `0100${String(10000000 + (phoneSeq += 1)).slice(-8)}`;

async function placeOrder(token, workspaceId, variantId, { paymentMethod = 'cod', qty = 1 } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `pay-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: qty }],
      contact: { fullName: 'Paying Buyer', phone: nextPhone() },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const initialize = (token, wid, orderId) =>
  request(app).post(`/api/v1/workspaces/${wid}/orders/${orderId}/payments`).set(bearer(token)).send({});

const capture = (token, wid, paymentId) =>
  request(app).post(`/api/v1/workspaces/${wid}/payments/${paymentId}/capture`).set(bearer(token)).send({});

describe('payment capture', () => {
  it('is idempotent — capturing twice credits the order only once', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 25000, stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const init = await initialize(auth.accessToken, workspace.id, order.id);
    expect(init.status).toBe(201);
    expect(init.body.payment.status).toBe('authorized');
    const paymentId = init.body.payment.id;

    const first = await capture(auth.accessToken, workspace.id, paymentId);
    expect(first.status).toBe(200);
    expect(first.body.payment.status).toBe('captured');

    const afterFirst = await db.Order.findByPk(order.id);
    const paidOnce = Number(afterFirst.amountPaid);
    expect(paidOnce).toBe(Number(afterFirst.totalAmount));
    expect(afterFirst.financialState).toBe('paid');

    const second = await capture(auth.accessToken, workspace.id, paymentId);
    expect(second.status).toBe(200);
    expect(second.body.payment.status).toBe('captured');

    const afterSecond = await db.Order.findByPk(order.id);
    expect(Number(afterSecond.amountPaid)).toBe(paidOnce);
  });

  it('refuses to capture a payment that is not authorized', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 9000, stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const failed = await db.Payment.create({
      workspaceId: workspace.id,
      orderId: order.id,
      providerCode: 'cod',
      status: 'failed',
      amount: order.totalAmount,
      currency: order.currency,
      providerReference: 'cod_failed_ref',
    });

    const res = await capture(auth.accessToken, workspace.id, failed.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_NOT_CAPTURABLE');

    const o = await db.Order.findByPk(order.id);
    expect(Number(o.amountPaid)).toBe(0);
  });

  it('never lets amountPaid exceed the order total across several payments', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 30000, stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const total = Number((await db.Order.findByPk(order.id)).totalAmount);

    // Two payment rows, each for the full order amount — a merchant who hit
    // "take payment" twice before capturing either.
    const rows = [];
    for (let i = 0; i < 2; i += 1) {
      const init = await initialize(auth.accessToken, workspace.id, order.id);
      expect(init.status).toBe(201);
      rows.push(init.body.payment.id);
    }

    for (const id of rows) {
      const res = await capture(auth.accessToken, workspace.id, id);
      expect(res.status).toBe(200);
    }

    const o = await db.Order.findByPk(order.id);
    expect(Number(o.amountPaid)).toBe(total);
    expect(o.financialState).toBe('paid');
  });
});

describe('no fake online payments while no gateway exists', () => {
  it('the public checkout accepts cash on delivery only', async () => {
    const { workspace, variant } = await setupWorkspaceWithProduct({ price: 5000, stock: 5 });

    const buyNow = (body) =>
      request(app)
        .post(`/api/v1/store/${workspace.id}/checkout`)
        .set('Idempotency-Key', `pm-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        .send(body);

    const card = await buyNow({
      item: { variantId: variant.id, quantity: 1 },
      contact: { fullName: 'Card Shopper', phone: nextPhone() },
      paymentMethod: 'card',
    });
    expect(card.status).toBe(422);
    expect(card.body.error.code).toBe('VALIDATION_ERROR');
    expect(card.body.error.details.some((d) => d.field === 'paymentMethod')).toBe(true);

    const cod = await buyNow({
      item: { variantId: variant.id, quantity: 1 },
      contact: { fullName: 'COD Shopper', phone: nextPhone() },
      paymentMethod: 'cod',
    });
    expect(cod.status).toBe(201);
  });

  it('staff may still record a manual non-COD order', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 5000, stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, { paymentMethod: 'bank_transfer' });
    expect(order.paymentMethod).toBe('bank_transfer');
  });

  it('in production, initializing a non-COD payment is refused — the mock provider is dev-only', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 5000, stock: 5 });
    const codOrder = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const cardOrder = await placeOrder(auth.accessToken, workspace.id, variant.id, { paymentMethod: 'card' });

    env.isProduction = true;
    try {
      const refused = await initialize(auth.accessToken, workspace.id, cardOrder.id);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('PAYMENT_PROVIDER_NOT_CONFIGURED');

      // COD is a real method — it keeps working in production.
      const allowed = await initialize(auth.accessToken, workspace.id, codOrder.id);
      expect(allowed.status).toBe(201);
      expect(allowed.body.payment.providerCode).toBe('cod');
    } finally {
      env.isProduction = false;
    }

    // Outside production the mock provider still stands in for a gateway.
    const dev = await initialize(auth.accessToken, workspace.id, cardOrder.id);
    expect(dev.status).toBe(201);
    expect(dev.body.payment.providerCode).toBe('mock');
  });
});
