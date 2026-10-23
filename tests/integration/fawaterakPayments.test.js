'use strict';

// Fawaterak as a store gateway (stage 1: card only), end to end through the
// real endpoints: the switch, connect, checkout, the webhook as a signal only,
// the return page, expiry, the sweep and refunds. Fawaterak is always a fake.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const logger = require('../../src/core/utils/logger');
const fake = require('../helpers/fakeFawaterakStore');
const fakePaymob = require('../helpers/fakePaymob');
const fawaterak = require('../../src/modules/payments/gateways/fawaterak');
const sweepService = require('../../src/modules/payments/paymentSweepService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let phoneSeq = 0;
const nextPhone = () => `0106${String(10000000 + (phoneSeq += 1)).slice(-8)}`;
const RETURN_URL = 'http://localhost:3001/store/x/pay/{orderId}';

const original = { ...env.payments };
const originalFawaterak = { ...env.payments.fawaterak };
let fw;
let paymob;

beforeEach(() => {
  env.payments.onlineEnabled = true;
  env.payments.credentialsKey = fakePaymob.newKey();
  Object.assign(env.payments.fawaterak, { enabled: true, betaWorkspaces: [] });
  fawaterak.clearTokenCache();
  paymob = fakePaymob.install();
  fw = fake.install();
});

afterEach(() => {
  Object.assign(env.payments.fawaterak, originalFawaterak);
  Object.assign(env.payments, original, { fawaterak: env.payments.fawaterak });
  jest.restoreAllMocks();
});

const gatewaysUrl = (wid) => `/api/v1/workspaces/${wid}/payments/gateways`;

function connect(token, wid, credentials = fake.credentials('live')) {
  return request(app).put(`${gatewaysUrl(wid)}/fawaterak`).set(bearer(token)).send({ credentials });
}

async function store({ mode = 'live', price = 20000, stock = 5 } = {}) {
  const setup = await setupWorkspaceWithProduct({ price, stock });
  const res = await connect(setup.auth.accessToken, setup.workspace.id, fake.credentials(mode));
  if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    ...setup,
    token: setup.auth.accessToken,
    wid: setup.workspace.id,
    connection: res.body.connection,
    hookToken: res.body.connection.webhookUrl.split('/').pop(),
  };
}

function buyNow(ctx, { paymentMethod = 'card', paymentProvider, headers = {} } = {}) {
  return request(app)
    .post(`/api/v1/store/${ctx.wid}/checkout`)
    .set('Idempotency-Key', `fw-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set(headers)
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Fawaterak Shopper', phone: nextPhone(), email: 'shopper@example.com' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Pay St', province: 'Cairo' },
      paymentMethod,
      ...(paymentProvider ? { paymentProvider } : {}),
      ...(paymentMethod === 'cod' ? {} : { returnUrl: RETURN_URL }),
    });
}

async function placeOnline(ctx, opts) {
  const res = await buyNow(ctx, opts);
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  const intentKey = fw.lastIntentKey();
  return { res, order: res.body.order, token: res.body.paymentToken, intentKey, total: Number(res.body.order.totalAmount) };
}

const hook = (ctx, body, variant = 'paid_json') =>
  request(app).post(`/api/v1/webhooks/payments/fawaterak/${ctx.hookToken}${variant ? `/${variant}` : ''}`).send(body);

const shopperReturn = (ctx, placed, query = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.wid}/orders/${placed.order.id}/payment/return`)
    .set('X-Payment-Token', placed.token)
    .send({ query });

const refund = (ctx, orderId, body) =>
  request(app).post(`/api/v1/workspaces/${ctx.wid}/orders/${orderId}/refunds`).set(bearer(ctx.token)).send(body);

const order = (id) => db.Order.findByPk(id);
const attemptOf = (orderId) => db.Payment.findOne({ where: { orderId }, order: [['createdAt', 'DESC']] });

async function overdue(placed) {
  await db.Order.update({ paymentExpiresAt: new Date(Date.now() - 60000) }, { where: { id: placed.order.id } });
}

// ---------------------------------------------------------------------------

describe('the PAYMENTS_FAWATERAK_* switch', () => {
  it('off: not listed, cannot be connected, never offered at checkout', async () => {
    env.payments.fawaterak.enabled = false;
    const setup = await setupWorkspaceWithProduct();
    const t = setup.auth.accessToken;
    const w = setup.workspace.id;

    const list = await request(app).get(gatewaysUrl(w)).set(bearer(t));
    expect(list.body.gateways.map((g) => g.code)).not.toContain('fawaterak');
    expect((await connect(t, w)).status).toBe(404);
    expect(await db.PaymentGatewayAccount.count({ where: { workspaceId: w } })).toBe(0);

    // An account connected while it was on: hidden everywhere once it is off.
    env.payments.fawaterak.enabled = true;
    expect((await connect(t, w)).status).toBe(200);
    env.payments.fawaterak.enabled = false;
    const methods = await request(app).get(`/api/v1/store/${w}/payment-methods`);
    expect(methods.body.methods.map((m) => m.id)).toEqual(['cod']);
    const dashboardMethods = await request(app).get(`/api/v1/workspaces/${w}/payments/methods`).set(bearer(t));
    expect(dashboardMethods.body.methods.map((m) => m.id)).not.toContain('fawaterak:card');
    const put = await request(app)
      .put(`/api/v1/workspaces/${w}/payments/methods`)
      .set(bearer(t))
      .send({ methods: [{ id: 'cod', enabled: true }, { id: 'fawaterak:card', enabled: true }] });
    expect(put.status).toBe(422);
    const checkout = await buyNow({ wid: w, variant: setup.variant }, { paymentProvider: 'fawaterak' });
    expect(checkout.status).toBe(422);
    expect(fw.callsTo('/createTransaction')).toHaveLength(0);
  });

  it('beta: only the stores named in PAYMENTS_FAWATERAK_BETA_WORKSPACES see it', async () => {
    const inBeta = await setupWorkspaceWithProduct();
    const other = await setupWorkspaceWithProduct();
    env.payments.fawaterak.betaWorkspaces = [inBeta.workspace.slug.toLowerCase()];

    const listed = async (s) =>
      (await request(app).get(gatewaysUrl(s.workspace.id)).set(bearer(s.auth.accessToken))).body.gateways.map((g) => g.code);
    expect(await listed(inBeta)).toContain('fawaterak');
    expect(await listed(other)).not.toContain('fawaterak');
    expect((await connect(other.auth.accessToken, other.workspace.id)).status).toBe(404);
    expect((await connect(inBeta.auth.accessToken, inBeta.workspace.id)).status).toBe(200);
    // Paymob and Kashier are not limited by Fawaterak's switch.
    expect(await listed(other)).toEqual(expect.arrayContaining(['paymob', 'kashier']));
  });
});

describe('connecting Fawaterak', () => {
  it('detects the mode from the OAuth client, reads the card method, and never echoes a key', async () => {
    const setup = await setupWorkspaceWithProduct();
    const t = setup.auth.accessToken;
    const w = setup.workspace.id;

    const test = await connect(t, w, fake.credentials('test'));
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({ methodsFromAccount: true, refundsInGatewayDashboard: true, webhookSetup: { automatic: true } });
    expect(test.body.connection).toMatchObject({ mode: 'test', status: 'active', methods: ['card'], notices: [] });
    expect(test.body.connection.settings).toEqual({ cardMethodId: fake.CARD_METHOD_ID, customerPaysFees: false });
    // The test client was only ever sent to the staging host.
    expect(fw.calls.filter((c) => c.url.startsWith(fake.HOSTS.live))).toHaveLength(0);

    const live = await connect(t, w, fake.credentials('live'));
    expect(live.body.connection.mode).toBe('live');

    for (const res of [test, live]) {
      const text = JSON.stringify(res.body);
      for (const mode of ['test', 'live']) {
        expect(text).not.toContain(fake.credentials(mode).clientSecret);
        expect(text).not.toContain(fake.credentials(mode).vendorKey);
      }
    }
    const row = await db.PaymentGatewayAccount.scope('withCredentials').findOne({ where: { workspaceId: w, providerCode: 'fawaterak' } });
    expect(row.credentialsEncrypted).not.toContain(fake.credentials('live').clientSecret);
    expect(row.credentialsEncrypted).not.toContain(fake.credentials('live').vendorKey);

    const list = await request(app).get(gatewaysUrl(w)).set(bearer(t));
    const entry = list.body.gateways.find((g) => g.code === 'fawaterak');
    expect(entry.setupSteps.en.length).toBe(entry.setupSteps.ar.length);
    expect(entry.credentialFields.map((f) => [f.key, f.secret])).toEqual([
      ['clientId', false],
      ['clientSecret', true],
      ['vendorKey', true],
    ]);
  });

  it('refuses keys neither host accepts, and an account with no card payment switched on', async () => {
    const setup = await setupWorkspaceWithProduct();
    const t = setup.auth.accessToken;
    const w = setup.workspace.id;

    const bad = await connect(t, w, { ...fake.credentials('live'), clientSecret: 'wrong-secret-0000000000' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('GATEWAY_AUTH_FAILED');

    fw.methods = fw.methods.filter((m) => !/visa/i.test(m.name_en));
    const noCard = await connect(t, w);
    expect(noCard.status).toBe(422);
    expect(noCard.body.error.details[0].message).toMatch(/no card payment/);

    const missing = await connect(t, w, { clientId: 'fake-oauth-client-live-0000', clientSecret: 'x'.repeat(20) });
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].field).toBe('credentials.vendorKey');
    expect(await db.PaymentGatewayAccount.count({ where: { workspaceId: w } })).toBe(0);
  });

  it('another store with the same Client ID and a different secret is refused, and borrows nothing', async () => {
    const lines = [];
    for (const level of ['error', 'warn', 'info', 'debug']) {
      jest.spyOn(logger, level).mockImplementation((...args) => lines.push(JSON.stringify(args)));
    }
    const a = await store(); // A's token is now cached in this process
    const b = await setupWorkspaceWithProduct();
    const wrong = { ...fake.credentials('live'), clientSecret: 'another-merchants-guess-0000', vendorKey: 'store-b-vendor-key-00000' };

    const res = await connect(b.auth.accessToken, b.workspace.id, wrong);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GATEWAY_AUTH_FAILED');
    expect(await db.PaymentGatewayAccount.count({ where: { workspaceId: b.workspace.id } })).toBe(0);
    // The wrong secret was put to Fawaterak itself, on both hosts.
    expect(fw.callsTo('/oauth/token').filter((c) => c.body.client_secret === wrong.clientSecret)).toHaveLength(2);

    // A is untouched: its checkout still runs on its own keys.
    const placed = await placeOnline(a);
    expect(placed.res.status).toBe(201);

    const text = `${JSON.stringify(res.body)}\n${lines.join('\n')}`;
    for (const secret of [wrong.clientSecret, wrong.vendorKey, fake.credentials('live').clientSecret, fake.credentials('live').vendorKey]) {
      expect(text).not.toContain(secret);
    }
  });

  it('warns when the shopper pays Fawaterak\'s fees', async () => {
    fw.methods[0].commission_on_customer = 1;
    const ctx = await store();
    expect(ctx.connection.settings.customerPaysFees).toBe(true);
    expect(ctx.connection.notices).toEqual(['customer_pays_fees']);
  });
});

describe('Fawaterak checkout', () => {
  it('starts a direct card payment for exactly the order and sends the shopper to the card page', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const attempt = await attemptOf(placed.order.id);
    const call = fw.callsTo('/api/v3/createTransaction')[0];

    expect(call.url).toBe(`${fake.HOSTS.live}/api/v3/createTransaction`);
    expect(call.headers.authorization).toMatch(/^Bearer fake-access-token-live-/);
    expect(call.body).toMatchObject({
      payment_method_id: fake.CARD_METHOD_ID,
      cartTotal: placed.total / 100,
      currency: 'EGP',
      pay_load: { orderId: placed.order.id, attemptId: attempt.id },
      sendEmail: false,
      sendSMS: false,
      lang: 'ar',
      redirectionUrls: {
        successUrl: `http://localhost:3001/store/x/pay/${placed.order.id}`,
        failUrl: `http://localhost:3001/store/x/pay/${placed.order.id}`,
        webhookUrl: `${ctx.connection.webhookUrl}/paid_json`,
      },
    });
    expect(call.body.cartItems).toEqual([{ name: expect.stringContaining('Order'), price: placed.total / 100, quantity: 1 }]);
    expect(call.body.due_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(attempt.providerOrderId).toBe(placed.intentKey);
    expect(attempt.redirectUrl).toBe(`${fake.HOSTS.live}/link/${placed.intentKey.slice(0, 5)}`);
    expect(placed.res.body.payment.redirectUrl).toBe(attempt.redirectUrl);
  });

  it('takes no wallet payment through Fawaterak', async () => {
    const ctx = await store();
    const methods = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(methods.body.methods.map((m) => m.id)).toEqual(['cod', 'fawaterak:card']);
    expect((await buyNow(ctx, { paymentMethod: 'wallet' })).status).toBe(422);
  });

  it('offers a test account only in the store preview, and flags what it takes', async () => {
    const ctx = await store({ mode: 'test' });
    const methods = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(methods.body.methods.map((m) => m.id)).toEqual(['cod']);

    const { token } = (await request(app).post(`/api/v1/workspaces/${ctx.wid}/payments/preview-token`).set(bearer(ctx.token))).body;
    const placed = await placeOnline(ctx, { headers: { 'X-Store-Preview': token } });
    expect(fw.intent(placed.intentKey).mode).toBe('test');
    fw.pay(placed.intentKey);
    const res = await hook(ctx, fw.paidWebhook(placed.intentKey));
    expect(res.body.confirmed).toBe('paid');
    expect((await order(placed.order.id)).riskFlags).toContain('test_payment');
  });
});

describe('Fawaterak webhooks: a signal, never the truth', () => {
  it('a signed webhook makes us ask Fawaterak, and the order is paid from its answer', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);

    const res = await hook(ctx, fw.paidWebhook(placed.intentKey));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, confirmed: 'paid' });
    expect(fw.callsTo('/api/v3/getTransactionData')).toHaveLength(1);

    const o = await order(placed.order.id);
    expect(o.financialState).toBe('paid');
    expect(Number(o.amountPaid)).toBe(placed.total);
    const attempt = await attemptOf(o.id);
    expect(attempt).toMatchObject({ status: 'captured', providerTransactionId: String(fw.intent(placed.intentKey).transactionId) });

    // The webhook is kept without its signature, the legacy key or the customer's details.
    const events = await db.PaymentEvent.findAll({ where: { orderId: o.id } });
    expect(events.map((e) => e.source).sort()).toEqual(['inquiry', 'webhook']);
    const stored = JSON.stringify(events.map((e) => e.payload));
    for (const word of ['transactionHashKey', 'api_key', 'customerData', 'payer@example.com']) expect(stored).not.toContain(word);
    expect((await db.PaymentGatewayAccount.findByPk(events[0].accountId)).lastWebhookAt).toBeTruthy();
  });

  it('refuses a forged webhook, and asks Fawaterak nothing', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);

    const forged = await hook(ctx, fw.paidWebhook(placed.intentKey, { key: 'someone-elses-vendor-key-0000' }));
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    const unsigned = fw.paidWebhook(placed.intentKey);
    delete unsigned.transactionHashKey;
    expect((await hook(ctx, unsigned)).status).toBe(401);
    expect((await hook(ctx, { hello: 'world' })).status).toBe(401);
    // A signed body whose signed fields were changed afterwards.
    expect((await hook(ctx, { ...fw.paidWebhook(placed.intentKey), transaction_key: 'another-intent' })).status).toBe(401);

    expect(fw.callsTo('/api/v3/getTransactionData')).toHaveLength(0);
    expect((await order(placed.order.id)).financialState).toBe('pending');
    expect(await db.PaymentEvent.count()).toBe(0);
  });

  it('a validly signed webhook that says paid changes nothing while Fawaterak says unpaid', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    // Not paid at Fawaterak; the status and the amount are not signed.
    const res = await hook(ctx, fw.paidWebhook(placed.intentKey, { status: 'paid', paidAmount: '999999' }));
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe('pending');
    const o = await order(placed.order.id);
    expect(o.financialState).toBe('pending');
    expect(Number(o.amountPaid)).toBe(0);
    expect((await attemptOf(o.id)).status).toBe('initialized');
  });

  it('takes a payment of another amount, flagged, at what Fawaterak says was paid', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey, { total: 1 });
    await hook(ctx, fw.paidWebhook(placed.intentKey, { paidAmount: String(placed.total / 100) }));
    const o = await order(placed.order.id);
    expect(o.riskFlags).toContain('payment_amount_mismatch');
    expect(Number(o.amountPaid)).toBe(100);
    expect(o.financialState).toBe('partially_paid');
  });

  it('takes a payment in another currency, flagged, without counting it as paid money', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey, { currency: 'USD' });
    await hook(ctx, fw.paidWebhook(placed.intentKey));
    const o = await order(placed.order.id);
    expect(o.riskFlags).toContain('payment_amount_mismatch');
    expect(Number(o.amountPaid)).toBe(0);
    expect(o.financialState).toBe('pending');
    expect((await attemptOf(o.id)).status).toBe('captured');
  });

  it('a total Fawaterak sends that cannot be read is never recorded', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey, { total: 'two hundred' });
    const res = await hook(ctx, fw.paidWebhook(placed.intentKey));
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBeNull();
    expect((await order(placed.order.id)).financialState).toBe('pending');
  });

  it('a payment whose pay_load names another attempt is not recorded as paid', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey, { payLoad: { orderId: placed.order.id, attemptId: '00000000-0000-4000-8000-000000000000' } });
    await hook(ctx, fw.paidWebhook(placed.intentKey));
    expect((await order(placed.order.id)).financialState).toBe('pending');
  });

  it('the same webhook twice pays the order once', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);
    const body = fw.paidWebhook(placed.intentKey);

    expect((await hook(ctx, body)).body.confirmed).toBe('paid');
    const again = await hook(ctx, body);
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('duplicate');
    const o = await order(placed.order.id);
    expect(Number(o.amountPaid)).toBe(placed.total);
    expect(o.riskFlags).not.toContain('duplicate_payment');
    expect(await db.Payment.count({ where: { orderId: o.id, status: 'captured' } })).toBe(1);
  });

  it('a webhook racing the shopper\'s return records the payment once', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);

    const [webhook, back] = await Promise.all([hook(ctx, fw.paidWebhook(placed.intentKey)), shopperReturn(ctx, placed, { status: 'paid' })]);
    expect(webhook.status).toBe(200);
    // The return page may find the webhook's inquiry still running (it asks at
    // most every 5 seconds) and show "awaiting payment" for one more poll.
    expect(['paid', 'awaiting_payment']).toContain(back.body.payment.status);
    const o = await order(placed.order.id);
    expect(Number(o.amountPaid)).toBe(placed.total);
    expect(o.riskFlags).not.toContain('duplicate_payment');
    expect(await db.PaymentEvent.count({ where: { orderId: o.id, source: 'inquiry' } })).toBe(1);
  });

  it('paid after its stock was released and sold: recorded, still cancelled, flagged paid_after_expiry', async () => {
    const ctx = await store({ stock: 1 });
    const placed = await placeOnline(ctx);
    await overdue(placed);
    const expired = await request(app)
      .get(`/api/v1/store/${ctx.wid}/orders/${placed.order.id}/payment`)
      .set('X-Payment-Token', placed.token);
    expect(expired.body.payment.status).toBe('expired');
    // Someone else bought the last unit meanwhile.
    expect((await buyNow(ctx, { paymentMethod: 'cod' })).status).toBe(201);

    fw.pay(placed.intentKey);
    const res = await hook(ctx, fw.paidWebhook(placed.intentKey));
    expect(res.body.confirmed).toBe('paid');
    const o = await order(placed.order.id);
    expect(o.cancelledAt).toBeTruthy();
    expect(o.financialState).toBe('paid');
    expect(o.riskFlags).toContain('paid_after_expiry');
    expect(o.completedAt).toBeNull();
  });

  it('paid after expiry with stock left: reserved again and reopened', async () => {
    const ctx = await store({ stock: 3 });
    const placed = await placeOnline(ctx);
    await overdue(placed);
    await sweepService.sweep();
    expect((await order(placed.order.id)).cancelledAt).toBeTruthy();

    fw.pay(placed.intentKey);
    await hook(ctx, fw.paidWebhook(placed.intentKey));
    const o = await order(placed.order.id);
    expect(o.cancelledAt).toBeNull();
    expect(o.financialState).toBe('paid');
    expect(o.riskFlags).not.toContain('paid_after_expiry');
  });

  it('Fawaterak unreachable when the webhook comes: acknowledged, and the sweep records it later', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);
    fw.dataAnswer = () => ({ status: 503, json: { status: 'error', message: 'Service unavailable' } });

    const res = await hook(ctx, fw.paidWebhook(placed.intentKey));
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBeNull();
    expect((await order(placed.order.id)).financialState).toBe('pending');

    fw.dataAnswer = null;
    await db.Payment.update(
      { createdAt: new Date(Date.now() - 10 * 60 * 1000), lastInquiredAt: new Date(Date.now() - 60 * 60 * 1000) },
      { where: { orderId: placed.order.id }, silent: true }
    );
    const result = await sweepService.sweep();
    expect(result.last.inquired.orders).toBe(1);
    expect((await order(placed.order.id)).financialState).toBe('paid');
  });

  it('only the paid_json segment is accepted, and only for Fawaterak', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);
    expect((await hook(ctx, fw.paidWebhook(placed.intentKey), 'other')).status).toBe(404);
    expect((await request(app).post(`/api/v1/webhooks/payments/paymob/${ctx.hookToken}/paid_json`).send({})).status).toBe(404);
    // The plain URL (a dashboard default webhook) works too.
    expect((await hook(ctx, fw.paidWebhook(placed.intentKey), null)).body.confirmed).toBe('paid');
  });

  it('a signed refund webhook is acknowledged and changes nothing', async () => {
    const ctx = await store();
    const res = await hook(ctx, fake.refundWebhook(), null);
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
    expect(await db.PaymentEvent.count()).toBe(0);
    const forged = await hook(ctx, fake.refundWebhook({ key: 'not-the-vendor-key-000000' }), null);
    expect(forged.status).toBe(401);
  });

  it('a webhook still settles a payment started before the switch was turned off', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    env.payments.fawaterak.enabled = false;
    fw.pay(placed.intentKey);
    expect((await hook(ctx, fw.paidWebhook(placed.intentKey))).body.confirmed).toBe('paid');
    expect((await order(placed.order.id)).financialState).toBe('paid');
  });
});

describe('Fawaterak return page and expiry', () => {
  it('the return page asks Fawaterak (its redirect carries no signature)', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);
    // Whatever the query says, only Fawaterak's answer counts.
    const res = await shopperReturn(ctx, placed, { status: 'paid', transactionHashKey: 'f'.repeat(64) });
    expect(res.body.payment.status).toBe('paid');
    expect(fw.callsTo('/api/v3/getTransactionData')).toHaveLength(1);
  });

  it('never expires an order Fawaterak could not be asked about', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await overdue(placed);
    fw.dataAnswer = () => ({ status: 503, json: { status: 'error', message: 'down' } });
    let result = await sweepService.sweep();
    expect(result.last.expired.outcomes.unknown).toBe(1);
    expect((await order(placed.order.id)).cancelledAt).toBeNull();

    fw.dataAnswer = null;
    result = await sweepService.sweep();
    expect(result.last.expired.outcomes.expired).toBe(1);
  });
});

describe('Fawaterak late payments whose webhook never counted', () => {
  const dataCalls = () => fw.callsTo('/api/v3/getTransactionData').length;
  const askedHoursAgo = (orderId, hours) =>
    db.Payment.update({ lastInquiredAt: new Date(Date.now() - hours * 60 * 60 * 1000) }, { where: { orderId }, silent: true });

  it('the sweep finds a payment made on an expired attempt, and reopens the order', async () => {
    const ctx = await store({ stock: 3 });
    const placed = await placeOnline(ctx);
    await overdue(placed);
    await sweepService.sweep();
    expect((await attemptOf(placed.order.id)).status).toBe('expired');

    // Paid on the card page after that; no webhook ever arrives.
    fw.pay(placed.intentKey);
    await askedHoursAgo(placed.order.id, 3);
    const result = await sweepService.sweep();
    expect(result.last.late).toEqual({ attempts: 1, unknown: 0 });
    const o = await order(placed.order.id);
    expect(o.cancelledAt).toBeNull();
    expect(o.financialState).toBe('paid');
  });

  it('Sync finds it at once, after a webhook refused for a wrong key', async () => {
    const ctx = await store({ stock: 1 });
    const placed = await placeOnline(ctx);
    await overdue(placed);
    await request(app).get(`/api/v1/store/${ctx.wid}/orders/${placed.order.id}/payment`).set('X-Payment-Token', placed.token);
    expect((await buyNow(ctx, { paymentMethod: 'cod' })).status).toBe(201);

    fw.pay(placed.intentKey);
    // The merchant pasted another account's API key: every webhook is refused.
    expect((await hook(ctx, fw.paidWebhook(placed.intentKey, { key: 'a-wrong-vendor-key-0000' }))).status).toBe(401);
    expect((await order(placed.order.id)).financialState).toBe('pending');

    const sync = await request(app).post(`/api/v1/workspaces/${ctx.wid}/orders/${placed.order.id}/payments/sync`).set(bearer(ctx.token));
    expect(sync.status).toBe(200);
    expect(sync.body.timeline.unreachable).toBe(false);
    const o = await order(placed.order.id);
    expect(o.financialState).toBe('paid');
    expect(o.riskFlags).toContain('paid_after_expiry');
  });

  it('a replaced attempt is asked too: the shopper paid the first card page after retrying', async () => {
    const ctx = await store({ stock: 3 });
    const first = await placeOnline(ctx);
    const retry = await request(app)
      .post(`/api/v1/store/${ctx.wid}/orders/${first.order.id}/payment/retry`)
      .set('X-Payment-Token', first.token)
      .send({});
    expect(retry.status).toBe(200);
    expect((await db.Payment.findOne({ where: { providerOrderId: first.intentKey } })).status).toBe('cancelled');

    fw.pay(first.intentKey);
    await db.Payment.update({ lastInquiredAt: null }, { where: { providerOrderId: first.intentKey }, silent: true });
    const result = await sweepService.sweep();
    expect(result.last.late.attempts).toBe(1);
    expect((await order(first.order.id)).financialState).toBe('paid');
  });

  it('asks every two hours for a day, then stops', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await overdue(placed);
    await sweepService.sweep();
    let before = dataCalls();

    await sweepService.sweep(); // asked just now, at expiry
    expect(dataCalls()).toBe(before);

    await askedHoursAgo(placed.order.id, 3);
    await sweepService.sweep();
    expect(dataCalls()).toBe(before + 1);

    before = dataCalls();
    await askedHoursAgo(placed.order.id, 3);
    await db.Payment.update({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }, { where: { orderId: placed.order.id }, silent: true });
    await sweepService.sweep();
    expect(dataCalls()).toBe(before);
  });

  it('never asks Paymob about its expired attempts: its webhook carries the outcome', async () => {
    const setup = await setupWorkspaceWithProduct();
    const res = await request(app)
      .put(`${gatewaysUrl(setup.workspace.id)}/paymob`)
      .set(bearer(setup.auth.accessToken))
      .send({ credentials: fakePaymob.credentials('live'), settings: { cardIntegrationId: 111 } });
    expect(res.status).toBe(200);
    const ctx = { wid: setup.workspace.id, variant: setup.variant };
    const placed = await buyNow(ctx);
    expect(placed.status).toBe(201);
    await overdue({ order: placed.body.order });
    await sweepService.sweep();
    expect((await attemptOf(placed.body.order.id)).status).toBe('expired');

    await askedHoursAgo(placed.body.order.id, 3);
    const inquiries = () => paymob.calls.filter((c) => c.url.endsWith('/transaction_inquiry')).length;
    const before = inquiries();
    const result = await sweepService.sweep();
    expect(result.last.late.attempts).toBe(0);
    expect(inquiries()).toBe(before);
  });
});

describe('Fawaterak refunds (stage 1: in the Fawaterak dashboard)', () => {
  it('refuses a refund from here before writing anything, and says where to refund', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);
    await hook(ctx, fw.paidWebhook(placed.intentKey));

    const res = await refund(ctx, placed.order.id, { amount: 5000, reason: 'one item back' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('REFUND_IN_GATEWAY_DASHBOARD');
    expect(res.body.error.message).toMatch(/Fawaterak dashboard/);
    expect(await db.Refund.count({ where: { orderId: placed.order.id } })).toBe(0);
    expect(fw.calls.filter((c) => /refund/i.test(c.url))).toHaveLength(0);

    const timeline = await request(app)
      .get(`/api/v1/workspaces/${ctx.wid}/orders/${placed.order.id}/payment-timeline`)
      .set(bearer(ctx.token));
    expect(timeline.body.timeline.perPayment).toEqual([
      expect.objectContaining({ refundable: placed.total, refundInGatewayDashboard: true }),
    ]);
  });
});

describe('Fawaterak keys stay out of the logs', () => {
  it('no log line carries a key, a token or a signature', async () => {
    const lines = [];
    for (const level of ['error', 'warn', 'info', 'debug']) {
      jest.spyOn(logger, level).mockImplementation((...args) => lines.push(JSON.stringify(args)));
    }
    const ctx = await store();
    const placed = await placeOnline(ctx);
    fw.pay(placed.intentKey);
    const signed = fw.paidWebhook(placed.intentKey);
    await hook(ctx, { ...signed, transactionHashKey: 'a'.repeat(64) });
    fw.dataAnswer = () => ({ status: 503, json: { status: 'error', message: `echo ${fake.credentials('live').clientSecret}` } });
    await hook(ctx, signed);

    const text = lines.join('\n');
    const { clientSecret, vendorKey } = fake.credentials('live');
    for (const secret of [clientSecret, vendorKey, signed.transactionHashKey, 'fake-access-token-', ctx.hookToken]) {
      expect(text).not.toContain(secret);
    }
  });
});
