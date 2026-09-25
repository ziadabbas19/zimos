'use strict';

// Refunds. COD / manual refunds keep their one-step behaviour; a refund of a
// gateway payment is recorded as pending before the gateway is called and
// settled by its answer (or later, by webhook / sweep).

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const gateways = require('../../src/modules/payments/gateways');
const gatewayRuntime = require('../../src/modules/payments/gatewayRuntime');
const paymentService = require('../../src/modules/payments/paymentService');
const { GatewayRejectedError, GatewayError } = require('../../src/modules/payments/gateways/gatewayErrors');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

let phoneSeq = 0;
const nextPhone = () => `0101${String(10000000 + (phoneSeq += 1)).slice(-8)}`;

async function placeOrder(token, workspaceId, variantId, { paymentMethod = 'cod' } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: 'Refund Buyer', phone: nextPhone() },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Refund St' },
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const refund = (token, wid, orderId, body) =>
  request(app).post(`/api/v1/workspaces/${wid}/orders/${orderId}/refunds`).set(bearer(token)).send(body);

// A stand-in gateway. `refundImpl` decides each call's answer.
let refundImpl;
const fakeAdapter = {
  code: 'testpay',
  name: 'TestPay',
  refund: (...args) => refundImpl(...args),
};

beforeEach(() => {
  refundImpl = async (creds, { amount }) => ({ status: 'processed', providerRefundReference: `rf_${amount}_${Math.random()}` });
  const realGetAdapter = gateways.getAdapter;
  jest.spyOn(gateways, 'getAdapter').mockImplementation((code) => (code === 'testpay' ? fakeAdapter : realGetAdapter(code)));
  jest.spyOn(gatewayRuntime, 'contextFor').mockImplementation(async () => ({
    adapter: fakeAdapter,
    credentials: {},
    settings: {},
    mode: 'test',
  }));
});

afterEach(() => jest.restoreAllMocks());

/** A card order paid through the fake gateway: one captured payment per entry in `payments`. */
async function paidGatewayOrder({ price = 20000, payments = [null] } = {}) {
  const setup = await setupWorkspaceWithProduct({ price, stock: 10 });
  const order = await placeOrder(setup.auth.accessToken, setup.workspace.id, setup.variant.id, { paymentMethod: 'card' });
  const total = Number(order.totalAmount);
  const rows = [];
  for (const amount of payments) {
    rows.push(
      await db.Payment.create({
        workspaceId: setup.workspace.id,
        orderId: order.id,
        providerCode: 'testpay',
        status: 'captured',
        amount: amount || total,
        currency: order.currency,
        providerReference: `txn_${rows.length}`,
      })
    );
  }
  const paid = rows.reduce((sum, p) => sum + Number(p.amount), 0);
  await db.Order.update({ amountPaid: paid, financialState: 'paid' }, { where: { id: order.id } });
  return { ...setup, token: setup.auth.accessToken, order, total, payments: rows };
}

describe('COD / manual refunds are unchanged', () => {
  it('refunds in one step, up to the order total', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 20000, stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const total = Number(order.totalAmount);

    const first = await refund(auth.accessToken, workspace.id, order.id, { amount: 5000, reason: 'damaged' });
    expect(first.status).toBe(201);
    expect(first.body.refund.status).toBe('processed');
    expect(first.body.refund.source).toBe('merchant');
    expect(first.body.refund.creditNoteId).toBeTruthy();

    const over = await refund(auth.accessToken, workspace.id, order.id, { amount: total });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_ELIGIBLE_AMOUNT');

    const rest = await refund(auth.accessToken, workspace.id, order.id, { amount: total - 5000 });
    expect(rest.status).toBe(201);
    const after = await db.Order.findByPk(order.id);
    expect(Number(after.amountRefunded)).toBe(total);
    expect(after.financialState).toBe('refunded');
  });

  it('refuses a paymentId when nothing on the order went through a gateway', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 20000, stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const res = await refund(auth.accessToken, workspace.id, order.id, {
      amount: 100,
      paymentId: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REFUND_PAYMENT_INVALID');
  });
});

describe('gateway refunds', () => {
  it('records the refund as pending before the gateway is called, then settles it', async () => {
    const { token, workspace, order, total, payments } = await paidGatewayOrder();

    let seenDuringCall;
    let calls = 0;
    refundImpl = async (creds, { payment }) => {
      calls += 1;
      // Committed and visible from another connection while the gateway works.
      if (calls === 1) seenDuringCall = await db.Refund.findOne({ where: { orderId: order.id } });
      expect(payment.id).toBe(payments[0].id);
      return { status: 'processed', providerRefundReference: `rf_${calls}` };
    };

    const res = await refund(token, workspace.id, order.id, { amount: 5000, reason: 'size' });
    expect(res.status).toBe(201);
    expect(seenDuringCall.status).toBe('pending');
    expect(res.body.refund.status).toBe('processed');
    expect(res.body.refund.providerRefundReference).toBe('rf_1');
    expect(res.body.refund.processedAt).toBeTruthy();
    expect(res.body.refund.creditNoteId).toBeTruthy();

    const after = await db.Order.findByPk(order.id);
    expect(Number(after.amountRefunded)).toBe(5000);
    expect(after.financialState).toBe('partially_refunded');
    expect((await db.Payment.findByPk(payments[0].id)).status).toBe('partially_refunded');

    const restRes = await refund(token, workspace.id, order.id, { amount: total - 5000 });
    expect(restRes.body.refund.status).toBe('processed');
    const done = await db.Order.findByPk(order.id);
    expect(done.financialState).toBe('refunded');
    expect((await db.Payment.findByPk(payments[0].id)).status).toBe('refunded');
  });

  it('caps a refund at what was actually paid, not the order total', async () => {
    const { token, workspace, order, total } = await paidGatewayOrder();
    await db.Order.update({ amountPaid: total - 3000, financialState: 'partially_paid' }, { where: { id: order.id } });

    const res = await refund(token, workspace.id, order.id, { amount: total - 2000 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REFUND_EXCEEDS_ELIGIBLE_AMOUNT');
    expect(await db.Refund.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('a pending answer leaves the order untouched, holds the amount, and settles once', async () => {
    const { token, workspace, order, total } = await paidGatewayOrder();
    refundImpl = async () => ({ status: 'pending', providerRefundReference: 'rf_pending' });

    const res = await refund(token, workspace.id, order.id, { amount: total - 1000 });
    expect(res.status).toBe(201);
    expect(res.body.refund.status).toBe('pending');
    let after = await db.Order.findByPk(order.id);
    expect(Number(after.amountRefunded)).toBe(0);
    expect(after.financialState).toBe('paid');

    // The pending amount is spoken for.
    const second = await refund(token, workspace.id, order.id, { amount: 2000 });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('REFUND_EXCEEDS_ELIGIBLE_AMOUNT');

    // Settled later (webhook / sweep), twice — counted once.
    await paymentService.settleRefund(workspace.id, res.body.refund.id, { status: 'processed' });
    await paymentService.settleRefund(workspace.id, res.body.refund.id, { status: 'processed' });
    after = await db.Order.findByPk(order.id);
    expect(Number(after.amountRefunded)).toBe(total - 1000);
    expect(after.financialState).toBe('partially_refunded');
    expect(await db.CreditNote.count({ where: { refundId: res.body.refund.id } })).toBe(1);
  });

  it('a declined refund is recorded as failed and moves no money', async () => {
    const { token, workspace, order } = await paidGatewayOrder();
    refundImpl = async () => {
      throw new GatewayRejectedError('Refund amount exceeds the captured amount');
    };

    const res = await refund(token, workspace.id, order.id, { amount: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.refund.status).toBe('failed');
    expect(res.body.refund.failureReason).toMatch(/exceeds/);
    const after = await db.Order.findByPk(order.id);
    expect(Number(after.amountRefunded)).toBe(0);
    expect(after.financialState).toBe('paid');

    // A failed refund frees its amount again.
    refundImpl = async () => ({ status: 'processed' });
    const retry = await refund(token, workspace.id, order.id, { amount: 1000 });
    expect(retry.body.refund.status).toBe('processed');
  });

  it('no answer from the gateway leaves the refund pending instead of guessing', async () => {
    const { token, workspace, order } = await paidGatewayOrder();
    refundImpl = async () => {
      throw new GatewayError('timed out');
    };

    const res = await refund(token, workspace.id, order.id, { amount: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.refund.status).toBe('pending');
    expect(Number((await db.Order.findByPk(order.id)).amountRefunded)).toBe(0);
  });

  it('refunds a duplicate payment by name and leaves the order paid', async () => {
    const { token, workspace, order, total, payments } = await paidGatewayOrder({ payments: [null, null] });
    expect(Number((await db.Order.findByPk(order.id)).amountPaid)).toBe(total * 2);

    const res = await refund(token, workspace.id, order.id, { amount: total, paymentId: payments[1].id });
    expect(res.body.refund.status).toBe('processed');
    expect(res.body.refund.paymentId).toBe(payments[1].id);

    const after = await db.Order.findByPk(order.id);
    expect(after.financialState).toBe('paid');
    expect((await db.Payment.findByPk(payments[1].id)).status).toBe('refunded');
    expect((await db.Payment.findByPk(payments[0].id)).status).toBe('captured');
  });

  it('refuses one refund that would have to draw on two payments', async () => {
    const { token, workspace, order, total } = await paidGatewayOrder({ payments: [null, null] });
    const res = await refund(token, workspace.id, order.id, { amount: total + 100 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
  });

  it('lists the order refunds with their statuses', async () => {
    const { token, workspace, order } = await paidGatewayOrder();
    refundImpl = async () => ({ status: 'pending' });
    await refund(token, workspace.id, order.id, { amount: 1000 });

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/orders/${order.id}/refunds`).set(bearer(token));
    expect(list.status).toBe(200);
    expect(list.body.refunds).toHaveLength(1);
    expect(list.body.refunds[0].status).toBe('pending');

    const detail = await request(app).get(`/api/v1/workspaces/${workspace.id}/orders/${order.id}`).set(bearer(token));
    expect(detail.body.order.refunds).toHaveLength(1);
  });
});

describe('order completion at creation (COD and staff orders)', () => {
  it('issues the invoice, counts the customer order and stamps completedAt', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 20000, stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);

    const row = await db.Order.findByPk(order.id);
    expect(row.completedAt).toBeTruthy();
    expect(await db.Invoice.count({ where: { orderId: order.id } })).toBe(1);
    expect((await db.Customer.findByPk(row.customerId)).totalOrders).toBe(1);
  });
});
