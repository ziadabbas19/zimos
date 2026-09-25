'use strict';

// Gateway refunds (ours and ones made in Paymob's dashboard), the payments
// sweep, and the merchant's payment timeline / sync. Paymob is always the fake.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const fake = require('../helpers/fakePaymob');
const sweepService = require('../../src/modules/payments/paymentSweepService');
const paymentEventService = require('../../src/modules/payments/paymentEventService');
const onlinePaymentService = require('../../src/modules/payments/onlinePaymentService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let phoneSeq = 0;
const nextPhone = () => `0104${String(10000000 + (phoneSeq += 1)).slice(-8)}`;

const original = { ...env.payments };
let paymob;

beforeEach(() => {
  env.payments.onlineEnabled = true;
  env.payments.credentialsKey = fake.newKey();
  paymob = fake.install();
});

afterEach(() => {
  Object.assign(env.payments, original);
  jest.restoreAllMocks();
});

async function store({ price = 20000, stock = 5 } = {}) {
  const setup = await setupWorkspaceWithProduct({ price, stock });
  const res = await request(app)
    .put(`/api/v1/workspaces/${setup.workspace.id}/payments/gateways/paymob`)
    .set(bearer(setup.auth.accessToken))
    .send({ credentials: fake.credentials('live'), settings: { cardIntegrationId: 111, walletIntegrationId: 222 } });
  if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    ...setup,
    token: setup.auth.accessToken,
    wid: setup.workspace.id,
    hookToken: res.body.connection.webhookUrl.split('/').pop(),
  };
}

async function placeOnline(ctx) {
  const res = await request(app)
    .post(`/api/v1/store/${ctx.wid}/checkout`)
    .set('Idempotency-Key', `gr-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Refund Shopper', phone: nextPhone() },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
      paymentMethod: 'card',
      returnUrl: 'http://localhost:3001/pay',
    });
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { order: res.body.order, token: res.body.paymentToken, paymobOrderId: paymob.lastIntention().orderId };
}

const hook = (ctx, obj) =>
  request(app).post(`/api/v1/webhooks/payments/paymob/${ctx.hookToken}`).query(fake.webhook(obj).query).send(fake.webhook(obj).body);

async function paidOrder(ctx, txnId = 6100000 + Math.floor(Math.random() * 10000)) {
  const placed = await placeOnline(ctx);
  const obj = fake.transaction({ id: txnId, orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) });
  const res = await hook(ctx, obj);
  if (res.body.outcome !== 'paid') throw new Error(`not paid: ${JSON.stringify(res.body)}`);
  return { ...placed, txnId, total: Number(placed.order.totalAmount) };
}

const refund = (ctx, orderId, body) =>
  request(app).post(`/api/v1/workspaces/${ctx.wid}/orders/${orderId}/refunds`).set(bearer(ctx.token)).send(body);

describe('refunds through Paymob', () => {
  it('partial then full, each sent to Paymob with the transaction id and our secret key', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx, 6200001);

    const first = await refund(ctx, paid.order.id, { amount: 5000, reason: 'one item back' });
    expect(first.status).toBe(201);
    expect(first.body.refund.status).toBe('processed');
    const call = paymob.calls.find((c) => c.url.endsWith('/void_refund/refund'));
    expect(call.headers.authorization).toBe(`Token ${fake.credentials('live').secretKey}`);
    expect(call.body).toEqual({ transaction_id: 6200001, amount_cents: 5000 });
    expect((await db.Order.findByPk(paid.order.id)).financialState).toBe('partially_refunded');

    const rest = await refund(ctx, paid.order.id, { amount: paid.total - 5000 });
    expect(rest.body.refund.status).toBe('processed');
    const order = await db.Order.findByPk(paid.order.id);
    expect(order.financialState).toBe('refunded');
    expect(Number(order.amountRefunded)).toBe(paid.total);

    const over = await refund(ctx, paid.order.id, { amount: 1 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_ELIGIBLE_AMOUNT');
  });

  it('a refund Paymob declines is recorded as failed with its reason', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx);
    paymob.refundAnswer = () => ({ status: 400, json: { detail: 'Transaction is not refundable yet' } });
    const res = await refund(ctx, paid.order.id, { amount: 1000 });
    expect(res.body.refund.status).toBe('failed');
    expect(res.body.refund.failureReason).toMatch(/not refundable yet/);
    expect(Number((await db.Order.findByPk(paid.order.id)).amountRefunded)).toBe(0);
  });

  it('a refund still pending at Paymob is settled by its callback', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx, 6200002);
    paymob.refundAnswer = (body) => ({
      status: 200,
      json: fake.transaction({ id: 7777001, orderId: 1, amount: body.amount_cents, pending: true, success: false, is_refund: true, parent_transaction: body.transaction_id }),
    });
    const res = await refund(ctx, paid.order.id, { amount: 3000 });
    expect(res.body.refund.status).toBe('pending');
    expect(res.body.refund.providerRefundReference).toBe('7777001');

    const done = fake.transaction({ id: 7777001, orderId: paid.paymobOrderId, amount: 3000, is_refund: true, parent_transaction: 6200002 });
    const cb = await hook(ctx, done);
    expect(cb.body.outcome).toBe('refund_processed');
    const row = await db.Refund.findByPk(res.body.refund.id);
    expect(row.status).toBe('processed');
    expect(row.source).toBe('merchant');
    expect(await db.Refund.count({ where: { orderId: paid.order.id } })).toBe(1);
  });

  it('a refund whose call got no answer is matched to its callback by amount', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx, 6200003);
    paymob.refundAnswer = () => ({ status: 503, json: { detail: 'upstream' } });
    const res = await refund(ctx, paid.order.id, { amount: 2500 });
    expect(res.body.refund.status).toBe('pending');
    expect(res.body.refund.providerRefundReference).toBeNull();

    await hook(ctx, fake.transaction({ id: 7777002, orderId: paid.paymobOrderId, amount: 2500, is_refund: true, parent_transaction: 6200003 }));
    const row = await db.Refund.findByPk(res.body.refund.id);
    expect(row.status).toBe('processed');
    expect(row.providerRefundReference).toBe('7777002');
  });

  it('records a refund made in the Paymob dashboard, once', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx, 6200004);
    const obj = fake.transaction({ id: 7777003, orderId: paid.paymobOrderId, amount: 4000, is_refund: true, parent_transaction: 6200004 });

    expect((await hook(ctx, obj)).body.outcome).toBe('gateway_refund_recorded');
    expect((await hook(ctx, obj)).body.outcome).toBe('duplicate');

    const rows = await db.Refund.findAll({ where: { orderId: paid.order.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('gateway');
    expect(rows[0].status).toBe('processed');
    expect(rows[0].creditNoteId).toBeTruthy();
    const order = await db.Order.findByPk(paid.order.id);
    expect(Number(order.amountRefunded)).toBe(4000);
    expect(order.financialState).toBe('partially_refunded');
  });

  it('a void in the Paymob dashboard gives the whole payment back', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx, 6200005);
    await hook(ctx, fake.transaction({ id: 7777004, orderId: paid.paymobOrderId, amount: paid.total, is_void: true, parent_transaction: 6200005 }));
    const order = await db.Order.findByPk(paid.order.id);
    expect(order.financialState).toBe('refunded');
    expect(Number(order.amountRefunded)).toBe(paid.total);
  });

  it('ignores a refund callback for a payment it does not know', async () => {
    const ctx = await store();
    const res = await hook(ctx, fake.transaction({ id: 1, orderId: 2, amount: 100, is_refund: true, parent_transaction: 999 }));
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unmatched_refund');
  });
});

describe('payments sweep', () => {
  it('records a payment whose webhook never came', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await db.Payment.update({ createdAt: new Date(Date.now() - 10 * 60 * 1000) }, { where: { orderId: placed.order.id }, silent: true });
    paymob.transactions.set(placed.paymobOrderId, fake.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) }));

    const result = await sweepService.sweep();
    expect(result.last.inquired.orders).toBe(1);
    expect((await db.Order.findByPk(placed.order.id)).financialState).toBe('paid');
  });

  it('expires overdue orders, but never one Paymob could not be asked about', async () => {
    const ctx = await store({ stock: 5 });
    const a = await placeOnline(ctx);
    const b = await placeOnline(ctx);
    await db.Order.update({ paymentExpiresAt: new Date(Date.now() - 60000) }, { where: { id: [a.order.id, b.order.id] } });

    paymob.inquiryStatus = 503;
    let result = await sweepService.sweep();
    expect(result.last.expired.outcomes.unknown).toBe(2);
    expect((await db.Order.findByPk(a.order.id)).cancelledAt).toBeNull();

    paymob.inquiryStatus = null;
    result = await sweepService.sweep();
    expect(result.last.expired.outcomes.expired).toBe(2);
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(0);
  });

  it('skips an order another process holds locked', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await db.Order.update({ paymentExpiresAt: new Date(Date.now() - 60000) }, { where: { id: placed.order.id } });

    const t = await db.sequelize.transaction();
    try {
      await db.Order.findOne({ where: { id: placed.order.id }, lock: t.LOCK.UPDATE, transaction: t });
      const outcome = await onlinePaymentService.expireOrder(placed.order.id, { skipLocked: true });
      expect(outcome).toBe('locked');
    } finally {
      await t.rollback();
    }
    expect(await onlinePaymentService.expireOrder(placed.order.id, { skipLocked: true })).toBe('expired');
  });

  it('processes again a callback whose processing failed', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const obj = fake.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) });

    const spy = jest.spyOn(onlinePaymentService, 'recordPaymentTransaction').mockRejectedValueOnce(new Error('db blip'));
    const res = await hook(ctx, obj);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('error');
    expect((await db.Order.findByPk(placed.order.id)).financialState).toBe('pending');
    spy.mockRestore();

    const result = await paymentEventService.reprocessPending();
    expect(result.processed).toBe(1);
    expect((await db.Order.findByPk(placed.order.id)).financialState).toBe('paid');
  });

  it('settles a pending refund by looking it up', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx, 6200006);
    paymob.refundAnswer = (body) => ({
      status: 200,
      json: fake.transaction({ id: 7777005, orderId: 1, amount: body.amount_cents, pending: true, success: false, is_refund: true, parent_transaction: 6200006 }),
    });
    const res = await refund(ctx, paid.order.id, { amount: 1500 });
    expect(res.body.refund.status).toBe('pending');
    await db.Refund.update({ createdAt: new Date(Date.now() - 10 * 60 * 1000) }, { where: { id: res.body.refund.id }, silent: true });
    paymob.transactionsById.set('7777005', fake.transaction({ id: 7777005, orderId: 1, amount: 1500, is_refund: true, parent_transaction: 6200006 }));

    const result = await sweepService.sweep();
    expect(result.last.refunds.settled).toBe(1);
    expect((await db.Refund.findByPk(res.body.refund.id)).status).toBe('processed');
  });
});

describe('merchant payment timeline and sync', () => {
  it('shows attempts, events, refunds, what can be refunded and the alerts', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await hook(ctx, fake.transaction({ id: 6300001, orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) }));
    // Paid a second time through a retried attempt at Paymob's side.
    await db.Payment.create({
      workspaceId: ctx.wid,
      orderId: placed.order.id,
      providerCode: 'paymob',
      method: 'card',
      mode: 'live',
      status: 'initialized',
      amount: placed.order.totalAmount,
      currency: 'EGP',
      providerOrderId: '55555',
    });
    await hook(ctx, fake.transaction({ id: 6300002, orderId: 55555, amount: Number(placed.order.totalAmount) }));

    const res = await request(app)
      .get(`/api/v1/workspaces/${ctx.wid}/orders/${placed.order.id}/payment-timeline`)
      .set(bearer(ctx.token));
    expect(res.status).toBe(200);
    const tl = res.body.timeline;
    expect(tl.alerts).toEqual(['duplicate_payment']);
    expect(tl.attempts).toHaveLength(2);
    expect(tl.events.map((e) => e.outcome)).toEqual(['paid', 'paid']);
    expect(tl.refundVia).toBe('gateway');
    expect(tl.refundable).toBe(2 * Number(placed.order.totalAmount));
    expect(tl.perPayment).toHaveLength(2);

    // One click: refund the duplicate.
    const dup = tl.attempts[1];
    const r = await refund(ctx, placed.order.id, { amount: Number(dup.amount), paymentId: dup.id });
    expect(r.body.refund.status).toBe('processed');
    expect((await db.Order.findByPk(placed.order.id)).financialState).toBe('paid');
  });

  it('sync asks Paymob now', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    paymob.transactions.set(placed.paymobOrderId, fake.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) }));
    const res = await request(app)
      .post(`/api/v1/workspaces/${ctx.wid}/orders/${placed.order.id}/payments/sync`)
      .set(bearer(ctx.token));
    expect(res.status).toBe(200);
    expect(res.body.timeline.amountPaid).toBe(Number(placed.order.totalAmount));
    expect(res.body.timeline.unreachable).toBe(false);
  });
});
