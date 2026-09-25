'use strict';

// Online payments through a merchant's own Kashier account, end to end through
// the real endpoints: connect, checkout, webhooks, inquiry, refunds, the sweep,
// and a store with both Kashier and Paymob. Both gateways are always fakes.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const fake = require('../helpers/fakeKashier');
const fakePaymob = require('../helpers/fakePaymob');
const sweepService = require('../../src/modules/payments/paymentSweepService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let phoneSeq = 0;
const nextPhone = () => `0105${String(10000000 + (phoneSeq += 1)).slice(-8)}`;
const RETURN_URL = 'http://localhost:3001/store/x/pay/{orderId}';

const original = { ...env.payments };
let kashier;
let paymob;

beforeEach(() => {
  env.payments.onlineEnabled = true;
  env.payments.credentialsKey = fakePaymob.newKey();
  paymob = fakePaymob.install();
  kashier = fake.install();
});

afterEach(() => {
  Object.assign(env.payments, original);
  jest.restoreAllMocks();
});

const gatewaysUrl = (wid) => `/api/v1/workspaces/${wid}/payments/gateways`;

function connectKashier(token, wid, credentials = fake.credentials('live')) {
  return request(app).put(`${gatewaysUrl(wid)}/kashier`).set(bearer(token)).send({ credentials });
}

async function store({ mode = 'live', price = 20000, stock = 5 } = {}) {
  const setup = await setupWorkspaceWithProduct({ price, stock });
  const res = await connectKashier(setup.auth.accessToken, setup.workspace.id, fake.credentials(mode));
  if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    ...setup,
    token: setup.auth.accessToken,
    wid: setup.workspace.id,
    connection: res.body.connection,
    hookToken: res.body.connection.webhookUrl.split('/').pop(),
  };
}

function buyNow(ctx, { paymentMethod = 'card', headers = {} } = {}) {
  return request(app)
    .post(`/api/v1/store/${ctx.wid}/checkout`)
    .set('Idempotency-Key', `ks-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set(headers)
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Kashier Shopper', phone: nextPhone(), email: 'shopper@example.com' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Pay St', province: 'Cairo' },
      paymentMethod,
      ...(paymentMethod === 'cod' ? {} : { returnUrl: RETURN_URL }),
    });
}

async function placeOnline(ctx, opts) {
  const res = await buyNow(ctx, opts);
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { res, order: res.body.order, token: res.body.paymentToken, session: kashier.lastSession() };
}

const hook = (ctx, { body, headers }) =>
  request(app).post(`/api/v1/webhooks/payments/kashier/${ctx.hookToken}`).set(headers).send(body);

async function paidOrder(ctx, { settled = true } = {}) {
  const placed = await placeOnline(ctx);
  const { transactionId } = kashier.markPaid(placed.session, { settled });
  const res = await hook(ctx, fake.webhook(placed.session, { transactionId }));
  if (res.body.outcome !== 'paid') throw new Error(`not paid: ${JSON.stringify(res.body)}`);
  return { ...placed, transactionId, total: Number(placed.order.totalAmount) };
}

const refund = (ctx, orderId, body) =>
  request(app).post(`/api/v1/workspaces/${ctx.wid}/orders/${orderId}/refunds`).set(bearer(ctx.token)).send(body);

// ---------------------------------------------------------------------------

describe('connecting Kashier', () => {
  it('detects the mode from the keys and reads the methods from the account', async () => {
    const setup = await setupWorkspaceWithProduct();
    const res = await connectKashier(setup.auth.accessToken, setup.workspace.id, fake.credentials('test'));
    expect(res.status).toBe(200);
    expect(res.body.methodsFromAccount).toBe(true);
    expect(res.body.connection).toMatchObject({ mode: 'test', status: 'active', methods: ['card', 'wallet'] });
    expect(res.body.connection.settings).toEqual({ entitledMethods: ['card', 'wallet'] });
    // The secret key was only ever sent to the test host, and no key is echoed back.
    expect(kashier.calls.filter((c) => c.url.startsWith(fake.HOSTS.live.api))).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(fake.credentials('test').secretKey);
    expect(JSON.stringify(res.body)).not.toContain(fake.credentials('test').apiKey);

    const live = await connectKashier(setup.auth.accessToken, setup.workspace.id, fake.credentials('live'));
    expect(live.body.connection.mode).toBe('live');

    const gateways = await request(app).get(gatewaysUrl(setup.workspace.id)).set(bearer(setup.auth.accessToken));
    const entry = gateways.body.gateways.find((g) => g.code === 'kashier');
    expect(entry.webhookSetup).toMatchObject({ automatic: true, perIntegration: false });
    expect(entry.setupSteps.en.length).toBe(entry.setupSteps.ar.length);
  });

  it('refuses keys neither host accepts, an unknown merchant ID and a refused API key', async () => {
    const setup = await setupWorkspaceWithProduct();
    const t = setup.auth.accessToken;
    const w = setup.workspace.id;

    const bad = await connectKashier(t, w, { ...fake.credentials('live'), secretKey: 'wrong-secret-key-000000000' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('GATEWAY_AUTH_FAILED');

    kashier.unknownMerchant = true;
    const mid = await connectKashier(t, w);
    expect(mid.status).toBe(422);
    expect(mid.body.error.code).toBe('GATEWAY_REJECTED');
    expect(mid.body.error.message).toMatch(/merchant ID/);
    kashier.unknownMerchant = false;

    kashier.apiKeyValid = false;
    const key = await connectKashier(t, w);
    expect(key.status).toBe(422);
    expect(key.body.error.message).toMatch(/Payment API key/);

    const malformed = await connectKashier(t, w, { ...fake.credentials('live'), merchantId: '12345' });
    expect(malformed.status).toBe(422);
    expect(malformed.body.error.details[0].field).toBe('credentials.merchantId');
    expect(await db.PaymentGatewayAccount.count({ where: { workspaceId: w } })).toBe(0);
  });

  it('only offers what the Kashier account is entitled to', async () => {
    kashier.entitlements = { card: true, wallet: false };
    const ctx = await store();
    expect(ctx.connection.methods).toEqual(['card']);
    const methods = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(methods.body.methods.map((m) => m.id)).toEqual(['cod', 'kashier:card']);
    const wallet = await buyNow(ctx, { paymentMethod: 'wallet' });
    expect(wallet.status).toBe(422);
  });
});

describe('Kashier checkout', () => {
  it('creates a session for exactly the chosen method and sends the shopper to it', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const attempt = await db.Payment.findOne({ where: { orderId: placed.order.id } });
    const { body, headers } = placed.session;

    expect(headers).toMatchObject({ authorization: fake.credentials('live').secretKey, 'api-key': fake.credentials('live').apiKey });
    expect(body).toMatchObject({
      merchantId: fake.MID,
      amount: (Number(placed.order.totalAmount) / 100).toFixed(2),
      currency: 'EGP',
      allowedMethods: 'card',
      type: 'one-time',
      paymentType: 'credit',
      display: 'ar',
      serverWebhook: ctx.connection.webhookUrl,
      merchantRedirect: `http://localhost:3001/store/x/pay/${placed.order.id}`,
    });
    // One reference per attempt, and the session ends before our attempt does.
    expect(body.order).toBe(attempt.providerOrderId);
    expect(body.order).toContain(attempt.id.replace(/-/g, ''));
    expect(new Date(body.expireAt).getTime()).toBeLessThan(new Date(attempt.expiresAt).getTime());
    expect(attempt.providerReference).toBe(placed.session.id);
    expect(placed.res.body.payment.redirectUrl).toBe(`https://payments.kashier.io/session/${placed.session.id}?mode=live`);
  });

  it('offers test-mode Kashier only in the store preview, and flags what it takes', async () => {
    const ctx = await store({ mode: 'test' });
    const methods = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(methods.body.methods.map((m) => m.id)).toEqual(['cod']);

    const { token } = (await request(app).post(`/api/v1/workspaces/${ctx.wid}/payments/preview-token`).set(bearer(ctx.token))).body;
    const placed = await placeOnline(ctx, { headers: { 'X-Store-Preview': token } });
    expect(kashier.lastSession().mode).toBe('test');
    const res = await hook(ctx, fake.webhook(placed.session, { mode: 'test' }));
    expect(res.body.outcome).toBe('paid');
    expect((await db.Order.findByPk(placed.order.id)).riskFlags).toContain('test_payment');
  });
});

describe('Kashier webhooks', () => {
  it('records a payment, and answers a repeat 409 without recording it twice', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const signed = fake.webhook(placed.session, { transactionId: 'TX-100001' });

    const first = await hook(ctx, signed);
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('paid');
    const order = await db.Order.findByPk(placed.order.id);
    expect(order.financialState).toBe('paid');
    expect(Number(order.amountPaid)).toBe(Number(placed.order.totalAmount));
    const attempt = await db.Payment.findOne({ where: { orderId: order.id } });
    expect(attempt).toMatchObject({ status: 'captured', providerTransactionId: 'TX-100001', maskedDisplay: 'Mastercard •••• 1118' });

    const again = await hook(ctx, signed);
    expect(again.status).toBe(409);
    expect(again.body.outcome).toBe('duplicate');
    expect(Number((await db.Order.findByPk(order.id)).amountPaid)).toBe(Number(placed.order.totalAmount));
    expect(await db.PaymentEvent.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('refuses a forged webhook and changes nothing', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const forged = fake.webhook(placed.session, { apiKey: 'someone-elses-key-0000000000' });
    const res = await hook(ctx, forged);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect((await db.Order.findByPk(placed.order.id)).financialState).toBe('pending');
    expect(await db.PaymentEvent.count()).toBe(0);
  });

  it('takes a payment of the wrong amount, flagged for the merchant', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const res = await hook(ctx, fake.webhook(placed.session, { amount: 1 }));
    expect(res.body.outcome).toBe('paid');
    const order = await db.Order.findByPk(placed.order.id);
    expect(order.riskFlags).toContain('payment_amount_mismatch');
    expect(Number(order.amountPaid)).toBe(100);
    expect(order.financialState).toBe('partially_paid');
  });

  it('a declined payment leaves the order waiting for another try', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const res = await hook(ctx, fake.webhook(placed.session, { status: 'FAILURE', message: 'Do not honour' }));
    expect(res.body.outcome).toBe('failed');
    const attempt = await db.Payment.findOne({ where: { orderId: placed.order.id } });
    expect(attempt).toMatchObject({ status: 'failed', failureReason: 'Do not honour' });
    const status = await request(app)
      .get(`/api/v1/store/${ctx.wid}/orders/${placed.order.id}/payment`)
      .set('X-Payment-Token', placed.token);
    expect(status.body.payment).toMatchObject({ status: 'awaiting_payment', canRetry: true });
  });
});

describe('Kashier inquiry', () => {
  it('the return page records a payment from a signed redirect', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const res = await request(app)
      .post(`/api/v1/store/${ctx.wid}/orders/${placed.order.id}/payment/return`)
      .set('X-Payment-Token', placed.token)
      .send({ query: fake.redirectQuery(placed.session) });
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('paid');
  });

  it('the return page asks Kashier when the redirect does not verify', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    kashier.markPaid(placed.session);
    const res = await request(app)
      .post(`/api/v1/store/${ctx.wid}/orders/${placed.order.id}/payment/return`)
      .set('X-Payment-Token', placed.token)
      .send({ query: { ...fake.redirectQuery(placed.session), signature: 'f'.repeat(64) } });
    expect(res.body.payment.status).toBe('paid');
    expect(kashier.callsTo(`/v3/payment/sessions/${placed.session.id}/payment`)).toHaveLength(1);
  });

  it('the sweep records a payment whose webhook never came, falling back to the orders search', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const { transactionId } = kashier.markPaid(placed.session);
    await db.Payment.update({ createdAt: new Date(Date.now() - 10 * 60 * 1000) }, { where: { orderId: placed.order.id }, silent: true });
    // The session lookup is unavailable; the order search answers instead.
    kashier.sessionPayments.delete(placed.session.id);

    const result = await sweepService.sweep();
    expect(result.last.inquired.orders).toBe(1);
    const attempt = await db.Payment.findOne({ where: { orderId: placed.order.id } });
    expect(attempt.status).toBe('captured');
    expect(attempt.providerTransactionId).toBe(transactionId);
  });

  it('Sync asks Kashier now; a session nobody paid yet changes nothing', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    kashier.sessionPayments.set(placed.session.id, { status: 'OPENED', merchantOrderId: placed.session.body.order });
    const sync = () =>
      request(app).post(`/api/v1/workspaces/${ctx.wid}/orders/${placed.order.id}/payments/sync`).set(bearer(ctx.token));
    let res = await sync();
    expect(res.status).toBe(200);
    expect(res.body.timeline.amountPaid).toBe(0);

    kashier.markPaid(placed.session);
    res = await sync();
    expect(res.body.timeline.amountPaid).toBe(Number(placed.order.totalAmount));
  });

  it('never expires an order Kashier could not be asked about', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await db.Order.update({ paymentExpiresAt: new Date(Date.now() - 60000) }, { where: { id: placed.order.id } });
    kashier.sessionLookupStatus = 503;
    let result = await sweepService.sweep();
    expect(result.last.expired.outcomes.unknown).toBe(1);
    expect((await db.Order.findByPk(placed.order.id)).cancelledAt).toBeNull();

    kashier.sessionLookupStatus = null;
    kashier.sessionPayments.set(placed.session.id, { status: 'EXPIRED', merchantOrderId: placed.session.body.order });
    result = await sweepService.sweep();
    expect(result.last.expired.outcomes.expired).toBe(1);
  });
});

describe('Kashier refunds', () => {
  it('partial refund through PUT /v3/orders/:kashierOrderId on the checkout host, in major units', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx);
    const kashierOrderId = kashier.orders.get(paid.session.body.order).orderId;

    const res = await refund(ctx, paid.order.id, { amount: 5050, reason: 'one item back' });
    expect(res.status).toBe(201);
    expect(res.body.refund.status).toBe('processed');
    const call = kashier.callsTo('/v3/orders/').find((c) => c.method === 'PUT');
    expect(call.url).toBe(`${fake.HOSTS.live.fep}/v3/orders/${kashierOrderId}`);
    expect(call.headers.authorization).toBe(fake.credentials('live').secretKey);
    expect(call.body).toEqual({ apiOperation: 'REFUND', reason: 'Refund', transaction: { amount: 50.5 } });
    expect((await db.Order.findByPk(paid.order.id)).financialState).toBe('partially_refunded');
  });

  it('voids the whole of a payment that has not settled yet', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx, { settled: false });
    const res = await refund(ctx, paid.order.id, { amount: paid.total });
    expect(res.body.refund.status).toBe('processed');
    const call = kashier.callsTo('/v3/orders/').find((c) => c.method === 'PUT');
    expect(call.body).toEqual({
      apiOperation: 'VOID',
      transaction: { amount: paid.total / 100, targetTransactionId: paid.transactionId },
    });
    expect((await db.Order.findByPk(paid.order.id)).financialState).toBe('refunded');
  });

  it('a PENDING refund is settled later by its webhook', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx);
    kashier.refundAnswer = (body) => ({
      status: 200,
      json: { status: 'SUCCESS', transactionId: 'TX-REF-1', response: { status: 'PENDING', amount: body.transaction.amount } },
    });
    const res = await refund(ctx, paid.order.id, { amount: 3000 });
    expect(res.body.refund).toMatchObject({ status: 'pending', providerRefundReference: 'TX-REF-1' });
    expect(Number((await db.Order.findByPk(paid.order.id)).amountRefunded)).toBe(0);

    const cb = await hook(ctx, fake.webhook(paid.session, { event: 'partial_refund', amount: 30, transactionId: 'TX-REF-1' }));
    expect(cb.body.outcome).toBe('refund_processed');
    const row = await db.Refund.findByPk(res.body.refund.id);
    expect(row).toMatchObject({ status: 'processed', source: 'merchant' });
    expect(Number((await db.Order.findByPk(paid.order.id)).amountRefunded)).toBe(3000);
    expect(await db.Refund.count({ where: { orderId: paid.order.id } })).toBe(1);
  });

  it('a PENDING refund is settled later by the sweep', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx);
    kashier.refundAnswer = () => ({ status: 200, json: { status: 'SUCCESS', transactionId: 'TX-REF-2', response: { status: 'PENDING' } } });
    const res = await refund(ctx, paid.order.id, { amount: 2000 });
    expect(res.body.refund.status).toBe('pending');
    await db.Refund.update({ createdAt: new Date(Date.now() - 10 * 60 * 1000) }, { where: { id: res.body.refund.id }, silent: true });
    kashier.transactions.set('TX-REF-2', { transactionId: 'TX-REF-2', trxType: 'refund', status: 'SUCCESS', currency: 'EGP' });

    const result = await sweepService.sweep();
    expect(result.last.refunds.settled).toBe(1);
    expect((await db.Refund.findByPk(res.body.refund.id)).status).toBe('processed');
  });

  it('a refund the Kashier balance cannot cover fails with REFUND_INSUFFICIENT_GATEWAY_BALANCE', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx);
    kashier.refundAnswer = () => ({
      status: 400,
      json: { error: { cause: 'insufficient balance' }, messages: { en: 'Insufficient available balance', ar: 'رصيد غير كاف' }, status: 'FAILURE' },
    });
    const res = await refund(ctx, paid.order.id, { amount: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.refund).toMatchObject({ status: 'failed', failureCode: 'REFUND_INSUFFICIENT_GATEWAY_BALANCE' });
    expect(res.body.refund.failureReason).toMatch(/balance/i);
    expect(Number((await db.Order.findByPk(paid.order.id)).amountRefunded)).toBe(0);

    // The same refusal arriving later, for a refund left pending.
    kashier.refundAnswer = () => ({ status: 200, json: { status: 'SUCCESS', transactionId: 'TX-REF-3', response: { status: 'PENDING' } } });
    const pending = await refund(ctx, paid.order.id, { amount: 1000 });
    await hook(
      ctx,
      fake.webhook(paid.session, { event: 'refund', status: 'FAILURE', amount: 10, transactionId: 'TX-REF-3', message: 'Insufficient balance' })
    );
    expect(await db.Refund.findByPk(pending.body.refund.id)).toMatchObject({
      status: 'failed',
      failureCode: 'REFUND_INSUFFICIENT_GATEWAY_BALANCE',
    });
  });

  it('a refund the order search cannot place is never sent, and fails', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx);
    kashier.ordersSearchStatus = 503;
    const res = await refund(ctx, paid.order.id, { amount: 1000 });
    expect(res.body.refund.status).toBe('failed');
    expect(kashier.callsTo('/v3/orders/').filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('records a refund made in the Kashier dashboard, once, as source gateway', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx);
    const signed = fake.webhook(paid.session, { event: 'refund', amount: 25, transactionId: 'TX-DASH-1' });
    const first = await hook(ctx, signed);
    expect(first.body.outcome).toBe('gateway_refund_recorded');
    const again = await hook(ctx, signed);
    expect(again.status).toBe(409);

    const rows = await db.Refund.findAll({ where: { orderId: paid.order.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'gateway', status: 'processed', providerRefundReference: 'TX-DASH-1' });
    expect(Number(rows[0].amount)).toBe(2500);
  });

  it('never turns the payment itself, relabelled as a refund, into one', async () => {
    const ctx = await store();
    const paid = await paidOrder(ctx);
    // `event` is outside the signature. The same signed data under another
    // event name is the same transaction in the same state: a repeat.
    const relabelled = await hook(ctx, fake.webhook(paid.session, { event: 'refund', transactionId: paid.transactionId }));
    expect(relabelled.status).toBe(409);

    // And should it ever get past the inbox, the payment's own transaction id
    // is refused as a refund.
    const account = { workspaceId: ctx.wid, providerCode: 'kashier' };
    const result = await require('../../src/modules/payments/gatewayRefundService').recordRefundTransaction(account, {
      kind: 'refund',
      status: 'processed',
      transactionId: paid.transactionId,
      parentTransactionId: null,
      providerOrderId: paid.session.body.order,
      amount: paid.total,
    });
    expect(result.outcome).toBe('refund_is_payment_ignored');
    expect(await db.Refund.count({ where: { orderId: paid.order.id } })).toBe(0);
  });
});

describe('Kashier and Paymob on one store', () => {
  async function bothStore() {
    const setup = await setupWorkspaceWithProduct({ price: 20000, stock: 5 });
    const t = setup.auth.accessToken;
    const w = setup.workspace.id;
    const p = await request(app)
      .put(`${gatewaysUrl(w)}/paymob`)
      .set(bearer(t))
      .send({ credentials: fakePaymob.credentials('live'), settings: { cardIntegrationId: 111, walletIntegrationId: 222 } });
    expect(p.status).toBe(200);
    const k = await connectKashier(t, w);
    expect(k.status).toBe(200);
    return { ...setup, token: t, wid: w };
  }

  it('the gateway connected second does not take over a method; the merchant chooses per method', async () => {
    const ctx = await bothStore();
    const list = await request(app).get(`/api/v1/workspaces/${ctx.wid}/payments/methods`).set(bearer(ctx.token));
    expect(list.body.methods.map((m) => [m.id, m.enabled])).toEqual([
      ['cod', true],
      ['paymob:card', true],
      ['paymob:wallet', true],
      ['kashier:card', false],
      ['kashier:wallet', false],
    ]);
    let offered = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(offered.body.methods.map((m) => m.id)).toEqual(['cod', 'paymob:card', 'paymob:wallet']);

    // Two gateways on for cards: refused.
    const both = await request(app)
      .put(`/api/v1/workspaces/${ctx.wid}/payments/methods`)
      .set(bearer(ctx.token))
      .send({
        methods: [
          { id: 'cod', enabled: true },
          { id: 'paymob:card', enabled: true },
          { id: 'kashier:card', enabled: true },
        ],
      });
    expect(both.status).toBe(422);
    expect(both.body.error.details[0].message).toMatch(/Only one gateway can take card payments/);

    // Cards through Kashier, wallets through Paymob.
    const chosen = await request(app)
      .put(`/api/v1/workspaces/${ctx.wid}/payments/methods`)
      .set(bearer(ctx.token))
      .send({
        methods: [
          { id: 'cod', enabled: true },
          { id: 'kashier:card', enabled: true },
          { id: 'paymob:wallet', enabled: true },
          { id: 'paymob:card', enabled: false },
          { id: 'kashier:wallet', enabled: false },
        ],
      });
    expect(chosen.status).toBe(200);
    offered = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(offered.body.methods.map((m) => m.id)).toEqual(['cod', 'kashier:card', 'paymob:wallet']);

    const card = await buyNow(ctx, { paymentMethod: 'card' });
    expect(card.status).toBe(201);
    expect(card.body.payment.redirectUrl).toContain('payments.kashier.io');
    expect(kashier.sessions).toHaveLength(1);
    expect(paymob.intentions).toHaveLength(0);

    const wallet = await buyNow(ctx, { paymentMethod: 'wallet' });
    expect(wallet.status).toBe(201);
    expect(wallet.body.payment.redirectUrl).toContain('unifiedcheckout');
    expect(paymob.intentions).toHaveLength(1);
    expect(kashier.sessions).toHaveLength(1);

    // Each gateway's webhook settles its own order.
    const cardOrder = await db.Payment.findOne({ where: { orderId: card.body.order.id } });
    expect(cardOrder.providerCode).toBe('kashier');
    const hookToken = (await db.PaymentGatewayAccount.findOne({ where: { workspaceId: ctx.wid, providerCode: 'kashier' } })).webhookToken;
    const signed = fake.webhook(kashier.lastSession());
    const res = await request(app).post(`/api/v1/webhooks/payments/kashier/${hookToken}`).set(signed.headers).send(signed.body);
    expect(res.body.outcome).toBe('paid');
    expect((await db.Order.findByPk(card.body.order.id)).financialState).toBe('paid');
    expect((await db.Order.findByPk(wallet.body.order.id)).financialState).toBe('pending');
  });

  it('a Kashier webhook cannot touch a Paymob attempt', async () => {
    const ctx = await bothStore();
    const wallet = await buyNow(ctx, { paymentMethod: 'wallet' });
    const attempt = await db.Payment.findOne({ where: { orderId: wallet.body.order.id } });
    const hookToken = (await db.PaymentGatewayAccount.findOne({ where: { workspaceId: ctx.wid, providerCode: 'kashier' } })).webhookToken;
    const pretend = { body: { order: attempt.providerOrderId, amount: '200.00', currency: 'EGP' } };
    const signed = fake.webhook(pretend);
    const res = await request(app).post(`/api/v1/webhooks/payments/kashier/${hookToken}`).set(signed.headers).send(signed.body);
    expect(res.body.outcome).toBe('unmatched');
    expect((await db.Order.findByPk(wallet.body.order.id)).financialState).toBe('pending');
  });
});
