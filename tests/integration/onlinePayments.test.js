'use strict';

// Online payments through a merchant's own Paymob account, end to end through
// the real endpoints. Paymob itself is always the fake in helpers/fakePaymob.

const { app, request, setupWorkspaceWithProduct, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const fake = require('../helpers/fakePaymob');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let phoneSeq = 0;
const nextPhone = () => `0103${String(10000000 + (phoneSeq += 1)).slice(-8)}`;
const RETURN_URL = 'http://localhost:3001/store/x/pay/return';

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

const gatewaysUrl = (wid) => `/api/v1/workspaces/${wid}/payments/gateways`;

async function connect(token, wid, { mode = 'live', settings = { cardIntegrationId: 111, walletIntegrationId: 222 } } = {}) {
  return request(app)
    .put(`${gatewaysUrl(wid)}/paymob`)
    .set(bearer(token))
    .send({ credentials: fake.credentials(mode), settings });
}

async function store({ mode = 'live', price = 20000, stock = 5 } = {}) {
  const setup = await setupWorkspaceWithProduct({ price, stock });
  const res = await connect(setup.auth.accessToken, setup.workspace.id, { mode });
  if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...setup, token: setup.auth.accessToken, wid: setup.workspace.id, connection: res.body.connection };
}

function checkout(wid, body, headers = {}) {
  return request(app)
    .post(`/api/v1/store/${wid}/checkout`)
    .set('Idempotency-Key', `op-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .set(headers)
    .send(body);
}

function buyNow(ctx, { paymentMethod = 'card', quantity = 1, extra = {}, headers = {} } = {}) {
  return checkout(
    ctx.wid,
    {
      item: { variantId: ctx.variant.id, quantity },
      contact: { fullName: 'Online Shopper', phone: nextPhone(), email: 'shopper@example.com' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Pay St', province: 'Cairo' },
      paymentMethod,
      ...(paymentMethod === 'cod' ? {} : { returnUrl: RETURN_URL }),
      ...extra,
    },
    headers
  );
}

const shopper = (ctx, orderId, token) => ({
  status: (q = '') =>
    request(app).get(`/api/v1/store/${ctx.wid}/orders/${orderId}/payment${q}`).set('X-Payment-Token', token),
  back: (query) =>
    request(app).post(`/api/v1/store/${ctx.wid}/orders/${orderId}/payment/return`).set('X-Payment-Token', token).send({ query }),
  retry: (body = {}) =>
    request(app).post(`/api/v1/store/${ctx.wid}/orders/${orderId}/payment/retry`).set('X-Payment-Token', token).send(body),
  cod: () =>
    request(app).post(`/api/v1/store/${ctx.wid}/orders/${orderId}/payment/switch-to-cod`).set('X-Payment-Token', token).send({}),
});

function sendWebhook(ctx, { body, query }, token = ctx.connection.webhookUrl.split('/').pop()) {
  return request(app).post(`/api/v1/webhooks/payments/paymob/${token}`).query(query).send(body);
}

async function placeOnline(ctx, opts) {
  const res = await buyNow(ctx, opts);
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  const paymobOrderId = paymob.lastIntention().orderId;
  return { res, order: res.body.order, token: res.body.paymentToken, paymobOrderId };
}

async function payViaWebhook(ctx, placed, overrides = {}) {
  const obj = fake.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount), ...overrides });
  return { obj, res: await sendWebhook(ctx, fake.webhook(obj)) };
}

// ---------------------------------------------------------------------------

describe('PAYMENTS_ONLINE_ENABLED off', () => {
  it('the storefront stays cash on delivery only, while the dashboard can still connect', async () => {
    env.payments.onlineEnabled = false;
    const ctx = await store();

    const methods = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(methods.status).toBe(200);
    expect(methods.body.methods.map((m) => m.id)).toEqual(['cod']);

    const card = await buyNow(ctx);
    expect(card.status).toBe(422);
    expect(card.body.error.code).toBe('VALIDATION_ERROR');
    expect(card.body.error.details[0].field).toBe('paymentMethod');

    const cod = await buyNow(ctx, { paymentMethod: 'cod' });
    expect(cod.status).toBe(201);
    expect(cod.body.paymentToken).toBeUndefined();
    expect(paymob.intentions).toHaveLength(0);
  });
});

describe('connecting Paymob', () => {
  it('answers 503 GATEWAYS_NOT_CONFIGURED without GATEWAY_CREDENTIALS_KEY', async () => {
    env.payments.credentialsKey = '';
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await connect(auth.accessToken, workspace.id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('GATEWAYS_NOT_CONFIGURED');
    const list = await request(app).get(gatewaysUrl(workspace.id)).set(bearer(auth.accessToken));
    expect(list.body.configured).toBe(false);
  });

  it('verifies the keys, stores them encrypted and never returns, logs or audits them', async () => {
    const ctx = await store({ mode: 'test' });
    expect(ctx.connection.mode).toBe('test');
    expect(ctx.connection.methods).toEqual(['card', 'wallet']);
    expect(ctx.connection.webhookUrl).toMatch(/\/api\/v1\/webhooks\/payments\/paymob\/[A-Za-z0-9_-]{43}$/);

    const creds = fake.credentials('test');
    const everything = JSON.stringify(
      (await request(app).get(gatewaysUrl(ctx.wid)).set(bearer(ctx.token))).body
    );
    for (const secret of Object.values(creds)) expect(everything).not.toContain(secret);

    const row = await db.PaymentGatewayAccount.scope('withCredentials').findOne({ where: { workspaceId: ctx.wid } });
    expect(row.credentialsEncrypted).toMatch(/^v1:/);
    for (const secret of Object.values(creds)) expect(row.credentialsEncrypted).not.toContain(secret);

    const audits = JSON.stringify(await db.AuditLog.findAll({ where: { workspaceId: ctx.wid } }));
    for (const secret of Object.values(creds)) expect(audits).not.toContain(secret);
    expect(audits).toContain('credentialsUpdated');
  });

  it('refuses keys Paymob rejects, and stores nothing', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    paymob.authStatus = 401;
    const res = await connect(auth.accessToken, workspace.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GATEWAY_AUTH_FAILED');
    expect(await db.PaymentGatewayAccount.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('refuses a test secret key with a live public key', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const res = await request(app)
      .put(`${gatewaysUrl(workspace.id)}/paymob`)
      .set(bearer(auth.accessToken))
      .send({ credentials: { ...fake.credentials('live'), secretKey: fake.credentials('test').secretKey }, settings: { cardIntegrationId: 1 } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GATEWAY_KEYS_MODE_MISMATCH');
  });

  it('is for the owner and the workspace manager only', async () => {
    const ctx = await store();
    const operator = await addMemberWithRole(ctx.token, ctx.wid, 'order_operator');
    const accountant = await addMemberWithRole(ctx.token, ctx.wid, 'accountant', 'Accountant');
    const manager = await addMemberWithRole(ctx.token, ctx.wid, 'workspace_manager', 'Manager');

    expect((await connect(operator.accessToken, ctx.wid)).status).toBe(403);
    expect((await connect(accountant.accessToken, ctx.wid)).status).toBe(403);
    expect((await request(app).get(gatewaysUrl(ctx.wid)).set(bearer(operator.accessToken))).status).toBe(403);
    expect((await connect(manager.accessToken, ctx.wid)).status).toBe(200);
  });

  it('refuses to disconnect while an order is waiting on its payment', async () => {
    const ctx = await store();
    await placeOnline(ctx);
    const res = await request(app).delete(`${gatewaysUrl(ctx.wid)}/paymob`).set(bearer(ctx.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('GATEWAY_HAS_PENDING_PAYMENTS');
  });
});

describe('payment methods', () => {
  it('lists, reorders and switches methods, COD included', async () => {
    const ctx = await store();
    const url = `/api/v1/workspaces/${ctx.wid}/payments/methods`;
    const list = await request(app).get(url).set(bearer(ctx.token));
    expect(list.body.methods.map((m) => m.id)).toEqual(['cod', 'paymob:card', 'paymob:wallet']);

    const put = await request(app)
      .put(url)
      .set(bearer(ctx.token))
      .send({ methods: [{ id: 'paymob:card', enabled: true }, { id: 'cod', enabled: false }, { id: 'paymob:wallet', enabled: true }] });
    expect(put.status).toBe(200);

    const shop = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(shop.body.methods.map((m) => m.id)).toEqual(['paymob:card', 'paymob:wallet']);

    const cod = await buyNow(ctx, { paymentMethod: 'cod' });
    expect(cod.status).toBe(422);
    expect(cod.body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');

    const none = await request(app)
      .put(url)
      .set(bearer(ctx.token))
      .send({ methods: [{ id: 'cod', enabled: false }, { id: 'paymob:card', enabled: false }] });
    expect(none.status).toBe(422);
  });

  it('shows test-mode methods only in the store preview', async () => {
    const ctx = await store({ mode: 'test' });
    const plain = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`);
    expect(plain.body.methods.map((m) => m.id)).toEqual(['cod']);

    const refused = await buyNow(ctx);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');

    const { token } = (await request(app).post(`/api/v1/workspaces/${ctx.wid}/payments/preview-token`).set(bearer(ctx.token))).body;
    const preview = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`).set('X-Store-Preview', token);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.methods.map((m) => m.id)).toEqual(['cod', 'paymob:card', 'paymob:wallet']);
    expect(preview.body.methods[1].mode).toBe('test');

    // A token for another store is worth nothing here.
    const other = await store({ mode: 'test' });
    const foreign = (await request(app).post(`/api/v1/workspaces/${other.wid}/payments/preview-token`).set(bearer(other.token))).body.token;
    const denied = await request(app).get(`/api/v1/store/${ctx.wid}/payment-methods`).set('X-Store-Preview', foreign);
    expect(denied.body.preview).toBe(false);

    const placed = await buyNow(ctx, { headers: { 'X-Store-Preview': token } });
    expect(placed.status).toBe(201);
    expect(placed.body.payment.mode).toBe('test');
  });
});

describe('online checkout', () => {
  it('places the order unpaid, not yet a sale, and sends the shopper to Paymob', async () => {
    const ctx = await store();
    const cart = (await request(app).post(`/api/v1/store/${ctx.wid}/cart`).send({})).body;
    await request(app)
      .post(`/api/v1/store/${ctx.wid}/cart/items`)
      .set('X-Cart-Token', cart.guestToken)
      .send({ variantId: ctx.variant.id, quantity: 1 });

    const res = await checkout(
      ctx.wid,
      {
        contact: { fullName: 'Card Shopper', phone: nextPhone() },
        shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
        paymentMethod: 'card',
        returnUrl: RETURN_URL,
      },
      { 'X-Cart-Token': cart.guestToken }
    );
    expect(res.status).toBe(201);
    const { order, payment, paymentToken } = res.body;
    expect(paymentToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(order.paymentTokenHash).toBeUndefined();
    expect(payment.status).toBe('initialized');
    expect(payment.redirectUrl).toMatch(/\/unifiedcheckout\/\?publicKey=egy_pk_live_.+&clientSecret=csk_\d+$/);
    expect(payment.expiresAt).toBeTruthy();

    const intention = paymob.lastIntention();
    expect(intention.headers.authorization).toBe(`Token ${fake.credentials('live').secretKey}`);
    expect(intention.body.amount).toBe(Number(order.totalAmount));
    expect(intention.body.currency).toBe('EGP');
    expect(intention.body.payment_methods).toEqual([111]);
    expect(intention.body.special_reference).toBe(payment.id);
    expect(intention.body.redirection_url).toBe(RETURN_URL);
    expect(intention.body.notification_url).toBe(ctx.connection.webhookUrl);

    const row = await db.Order.findByPk(order.id);
    expect(row.financialState).toBe('pending');
    expect(row.completedAt).toBeNull();
    expect(await db.Invoice.count({ where: { orderId: order.id } })).toBe(0);
    expect(await db.ConfirmationTask.count({ where: { orderId: order.id } })).toBe(0);
    expect((await db.Customer.findByPk(row.customerId)).totalOrders).toBe(0);
    expect((await db.Cart.findByPk(cart.id)).status).toBe('active');

    const detail = await request(app).get(`/api/v1/workspaces/${ctx.wid}/orders/${order.id}`).set(bearer(ctx.token));
    expect(detail.body.order.stage).toBe('awaiting_payment');
  });

  it('fills the {orderId} placeholder in the return URL', async () => {
    const ctx = await store();
    const res = await buyNow(ctx, { extra: { returnUrl: 'http://localhost:3001/store/x/pay/{orderId}' } });
    expect(res.status).toBe(201);
    expect(paymob.lastIntention().body.redirection_url).toBe(`http://localhost:3001/store/x/pay/${res.body.order.id}`);
  });

  it('a signed webhook marks it paid and completes it, once', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const { obj, res } = await payViaWebhook(ctx, placed);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('paid');

    const order = await db.Order.findByPk(placed.order.id);
    expect(order.financialState).toBe('paid');
    expect(Number(order.amountPaid)).toBe(Number(order.totalAmount));
    expect(order.paymentExpiresAt).toBeNull();
    expect(order.completedAt).toBeTruthy();
    expect(await db.Invoice.count({ where: { orderId: order.id } })).toBe(1);
    expect((await db.Customer.findByPk(order.customerId)).totalOrders).toBe(1);

    const payment = await db.Payment.findOne({ where: { orderId: order.id } });
    expect(payment.status).toBe('captured');
    expect(payment.providerTransactionId).toBe(String(obj.id));
    expect(payment.maskedDisplay).toBe('MasterCard •••• 2346');

    // Redelivered: stored once, counted once.
    const again = await sendWebhook(ctx, fake.webhook(obj));
    expect(again.body.outcome).toBe('duplicate');
    expect(Number((await db.Order.findByPk(order.id)).amountPaid)).toBe(Number(order.totalAmount));
    expect(await db.PaymentEvent.count({ where: { orderId: order.id } })).toBe(1);

    const detail = await request(app).get(`/api/v1/workspaces/${ctx.wid}/orders/${order.id}`).set(bearer(ctx.token));
    expect(detail.body.order.stage).toBe('ready_to_ship');

    const account = await db.PaymentGatewayAccount.findOne({ where: { workspaceId: ctx.wid } });
    expect(account.lastWebhookAt).toBeTruthy();
  });

  it('refuses a webhook with a bad signature, and an unknown token', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const obj = fake.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) });

    const forged = await sendWebhook(ctx, fake.webhook(obj, { secret: 'not-the-secret' }));
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    // A tampered amount breaks the signature too.
    const signed = fake.webhook(obj);
    signed.body.obj.amount_cents = 1;
    expect((await sendWebhook(ctx, signed)).status).toBe(401);

    expect((await sendWebhook(ctx, fake.webhook(obj), 'x'.repeat(43))).status).toBe(404);
    expect((await db.Order.findByPk(placed.order.id)).financialState).toBe('pending');
  });

  it('acknowledges callback types it does not act on', async () => {
    const ctx = await store();
    const res = await sendWebhook(ctx, { body: { type: 'TOKEN', obj: { token: 'x' } }, query: { hmac: 'x' } });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe(true);
  });

  it('flags a payment whose amount does not match the attempt', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await payViaWebhook(ctx, placed, { amount: Number(placed.order.totalAmount) - 100 });
    const order = await db.Order.findByPk(placed.order.id);
    expect(order.riskFlags).toContain('payment_amount_mismatch');
    expect(order.financialState).toBe('partially_paid');
  });

  it('a declined payment leaves the order waiting; the shopper retries and pays', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await payViaWebhook(ctx, placed, { success: false });

    const s = shopper(ctx, placed.order.id, placed.token);
    let status = (await s.status()).body.payment;
    expect(status.status).toBe('awaiting_payment');
    expect(status.attempt.status).toBe('failed');
    expect(status.attempt.failureReason).toBe('Do not honour');
    expect(status.canRetry).toBe(true);
    expect(status.canSwitchToCod).toBe(true);

    const retried = await s.retry({ paymentMethod: 'wallet' });
    expect(retried.status).toBe(200);
    expect(retried.body.payment.attempt.method).toBe('wallet');
    expect(retried.body.payment.attempt.redirectUrl).toMatch(/unifiedcheckout/);
    expect(paymob.lastIntention().body.payment_methods).toEqual([222]);
    expect(paymob.lastIntention().body.redirection_url).toBe(RETURN_URL);

    await payViaWebhook(ctx, { ...placed, paymobOrderId: paymob.lastIntention().orderId });
    status = (await s.status()).body.payment;
    expect(status.status).toBe('paid');
    expect(status.canRetry).toBe(false);
    expect((await db.Order.findByPk(placed.order.id)).paymentMethod).toBe('wallet');
  });

  it('the status endpoint needs the shopper token', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const wrong = await shopper(ctx, placed.order.id, 'nope').status();
    expect(wrong.status).toBe(404);
    const none = await request(app).get(`/api/v1/store/${ctx.wid}/orders/${placed.order.id}/payment`);
    expect(none.status).toBe(404);
  });

  it('?refresh=1 asks Paymob and records a payment the webhook never delivered', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    paymob.transactions.set(
      placed.paymobOrderId,
      fake.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) })
    );
    const res = await shopper(ctx, placed.order.id, placed.token).status('?refresh=1');
    expect(res.body.payment.status).toBe('paid');
    const inquiry = paymob.calls.find((c) => c.url.endsWith('/transaction_inquiry'));
    expect(inquiry.headers.authorization).toBe('Bearer auth-token-xyz');
    expect(inquiry.body).toEqual({ order_id: placed.paymobOrderId });
    const event = await db.PaymentEvent.findOne({ where: { orderId: placed.order.id } });
    expect(event.source).toBe('inquiry');
  });

  it('a signed redirect is recorded at once; a forged one is ignored', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const obj = fake.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) });

    const forged = { ...fake.redirectQuery(obj), hmac: 'f'.repeat(128) };
    const first = await shopper(ctx, placed.order.id, placed.token).back(forged);
    expect(first.status).toBe(200);
    expect(first.body.payment.status).toBe('awaiting_payment');

    const signed = await shopper(ctx, placed.order.id, placed.token).back(fake.redirectQuery(obj));
    expect(signed.body.payment.status).toBe('paid');
    const event = await db.PaymentEvent.findOne({ where: { orderId: placed.order.id } });
    expect(event.source).toBe('redirect');

    // The webhook for the same transaction arrives later: same signed content, same event.
    const late = await sendWebhook(ctx, fake.webhook(obj));
    expect(late.body.outcome).toBe('duplicate');
  });

  it('switching to cash on delivery makes it a COD order in every respect', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    const res = await shopper(ctx, placed.order.id, placed.token).cod();
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('cod');

    const order = await db.Order.findByPk(placed.order.id);
    expect(order.paymentMethod).toBe('cod');
    expect(order.paymentExpiresAt).toBeNull();
    expect(order.completedAt).toBeTruthy();
    expect(await db.ConfirmationTask.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.Invoice.count({ where: { orderId: order.id } })).toBe(1);
    expect((await db.Payment.findOne({ where: { orderId: order.id } })).status).toBe('cancelled');

    const detail = await request(app).get(`/api/v1/workspaces/${ctx.wid}/orders/${order.id}`).set(bearer(ctx.token));
    expect(detail.body.order.stage).toBe('pending_confirmation');

    // A payment that still lands on the abandoned attempt is taken, and flagged.
    await payViaWebhook(ctx, placed);
    const after = await db.Order.findByPk(order.id);
    expect(after.riskFlags).toContain('paid_after_cod_switch');
    expect(after.financialState).toBe('paid');

    const again = await shopper(ctx, placed.order.id, placed.token).cod();
    expect(again.status).toBe(409);
  });

  it('counts a discount when the payment lands, not when the order is placed', async () => {
    const ctx = await store();
    await db.Discount.create({
      workspaceId: ctx.wid,
      code: 'SAVE10',
      type: 'fixed',
      value: 1000,
      status: 'active',
      usageLimit: 1,
    });
    const placed = await placeOnline(ctx, { extra: { discountCode: 'SAVE10' } });
    expect(Number(placed.order.discountAmount)).toBe(1000);
    expect(await db.DiscountRedemption.count()).toBe(0);

    await payViaWebhook(ctx, placed);
    expect(await db.DiscountRedemption.count({ where: { orderId: placed.order.id } })).toBe(1);
    expect((await db.Discount.findOne({ where: { code: 'SAVE10' } })).usageCount).toBe(1);
  });

  it('a gateway that will not start the payment still leaves an order the shopper can switch to COD', async () => {
    const ctx = await store();
    paymob.intentionStatus = 500;
    const res = await buyNow(ctx);
    expect(res.status).toBe(201);
    expect(res.body.payment.status).toBe('failed');
    expect(res.body.payment.redirectUrl).toBeNull();
    const s = shopper(ctx, res.body.order.id, res.body.paymentToken);
    expect((await s.status()).body.payment.canSwitchToCod).toBe(true);
    expect((await s.cod()).body.payment.status).toBe('cod');
  });
});

describe('expiry', () => {
  async function overdue(ctx, placed) {
    await db.Order.update({ paymentExpiresAt: new Date(Date.now() - 60000) }, { where: { id: placed.order.id } });
  }

  it('asks Paymob first, then releases the stock and cancels the order', async () => {
    const ctx = await store({ stock: 1 });
    const placed = await placeOnline(ctx);
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(1);
    await overdue(ctx, placed);

    const res = await shopper(ctx, placed.order.id, placed.token).status();
    expect(res.body.payment.status).toBe('expired');
    expect(paymob.calls.some((c) => c.url.endsWith('/transaction_inquiry'))).toBe(true);

    const order = await db.Order.findByPk(placed.order.id);
    expect(order.cancellationReason).toBe('payment_expired');
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(0);
    expect((await db.Payment.findOne({ where: { orderId: order.id } })).status).toBe('expired');
    const detail = await request(app).get(`/api/v1/workspaces/${ctx.wid}/orders/${order.id}`).set(bearer(ctx.token));
    expect(detail.body.order.stage).toBe('cancelled');
  });

  it('never expires an order Paymob could not be asked about', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await overdue(ctx, placed);
    paymob.inquiryStatus = 503;
    const res = await shopper(ctx, placed.order.id, placed.token).status();
    expect(res.body.payment.status).toBe('awaiting_payment');
    expect((await db.Order.findByPk(placed.order.id)).cancelledAt).toBeNull();
  });

  it('an overdue order that Paymob says was paid is recorded as paid, not expired', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await overdue(ctx, placed);
    paymob.transactions.set(
      placed.paymobOrderId,
      fake.transaction({ orderId: placed.paymobOrderId, amount: Number(placed.order.totalAmount) })
    );
    const res = await shopper(ctx, placed.order.id, placed.token).status();
    expect(res.body.payment.status).toBe('paid');
  });

  it('paid after expiry with stock left: reserved again and reopened', async () => {
    const ctx = await store({ stock: 3 });
    const placed = await placeOnline(ctx);
    await overdue(ctx, placed);
    await shopper(ctx, placed.order.id, placed.token).status();
    expect((await db.Order.findByPk(placed.order.id)).cancelledAt).toBeTruthy();

    const { res } = await payViaWebhook(ctx, placed);
    expect(res.body.outcome).toBe('paid_reopened');
    const order = await db.Order.findByPk(placed.order.id);
    expect(order.cancelledAt).toBeNull();
    expect(order.financialState).toBe('paid');
    expect(order.riskFlags).not.toContain('paid_after_expiry');
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(1);
    expect(order.completedAt).toBeTruthy();
  });

  it('paid after expiry with the stock gone: paid, still cancelled, flagged', async () => {
    const ctx = await store({ stock: 1 });
    const placed = await placeOnline(ctx);
    await overdue(ctx, placed);
    await shopper(ctx, placed.order.id, placed.token).status();
    // Someone else bought the last unit meanwhile.
    expect((await buyNow(ctx, { paymentMethod: 'cod' })).status).toBe(201);

    await payViaWebhook(ctx, placed);
    const order = await db.Order.findByPk(placed.order.id);
    expect(order.cancelledAt).toBeTruthy();
    expect(order.financialState).toBe('paid');
    expect(order.riskFlags).toContain('paid_after_expiry');
    expect(order.completedAt).toBeNull();
  });

  it('a checkout needing the stock expires an overdue order holding it', async () => {
    const ctx = await store({ stock: 1 });
    const placed = await placeOnline(ctx);
    await overdue(ctx, placed);
    const res = await buyNow(ctx, { paymentMethod: 'cod' });
    expect(res.status).toBe(201);
    expect((await db.Order.findByPk(placed.order.id)).cancellationReason).toBe('payment_expired');
  });
});

describe('the standing rules', () => {
  it('paid twice: both recorded, flagged, nothing refunded', async () => {
    const ctx = await store();
    const placed = await placeOnline(ctx);
    await payViaWebhook(ctx, placed, { success: false });
    await shopper(ctx, placed.order.id, placed.token).retry({});
    const secondOrderId = paymob.lastIntention().orderId;

    await payViaWebhook(ctx, { ...placed, paymobOrderId: secondOrderId });
    // The first attempt's order at Paymob was paid after all.
    await payViaWebhook(ctx, placed, { id: 8123456 });

    const order = await db.Order.findByPk(placed.order.id);
    expect(order.riskFlags).toContain('duplicate_payment');
    expect(Number(order.amountPaid)).toBe(2 * Number(order.totalAmount));
    expect(order.financialState).toBe('paid');
    expect(await db.Refund.count({ where: { orderId: order.id } })).toBe(0);
    expect(paymob.calls.some((c) => c.url.includes('void_refund'))).toBe(false);
  });

  it('paid in test mode: flagged and cannot ship', async () => {
    const ctx = await store({ mode: 'test' });
    const { token } = (await request(app).post(`/api/v1/workspaces/${ctx.wid}/payments/preview-token`).set(bearer(ctx.token))).body;
    const placed = await placeOnline(ctx, { headers: { 'X-Store-Preview': token } });
    await payViaWebhook(ctx, placed);

    const order = await db.Order.findByPk(placed.order.id);
    expect(order.riskFlags).toContain('test_payment');
    const ship = await request(app)
      .post(`/api/v1/workspaces/${ctx.wid}/orders/${order.id}/shipments`)
      .set(bearer(ctx.token))
      .send({ carrierCode: 'manual' });
    expect(ship.status).toBe(409);
    expect(ship.body.error.code).toBe('ORDER_TEST_PAYMENT');
  });

  it('fraud rules: "block" only flags an online order; the blocklist still refuses', async () => {
    const ctx = await store();
    await db.Workspace.update(
      { settings: { fraud_rules: { action: 'block', duplicate_window_minutes: 60, block_blacklisted: true } } },
      { where: { id: ctx.wid } }
    );
    const phone = nextPhone();
    const contact = { fullName: 'Repeat Buyer', phone };
    const place = (paymentMethod) =>
      checkout(ctx.wid, {
        item: { variantId: ctx.variant.id, quantity: 1 },
        contact,
        paymentMethod,
        ...(paymentMethod === 'cod' ? {} : { returnUrl: RETURN_URL }),
      });

    expect((await place('cod')).status).toBe(201);
    expect((await place('cod')).body.error.code).toBe('ORDER_REJECTED');

    const online = await place('card');
    expect(online.status).toBe(201);
    expect(online.body.order.riskFlags).toContain('duplicate_order');

    // ...and switching that order to COD is refused like a COD order would be.
    const sw = await shopper(ctx, online.body.order.id, online.body.paymentToken).cod();
    expect(sw.status).toBe(422);
    expect(sw.body.error.code).toBe('ORDER_REJECTED');

    await db.Customer.update({ isBlacklisted: true }, { where: { workspaceId: ctx.wid } });
    const blocked = await place('card');
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('ORDER_REJECTED');
  });

  it('abandoned checkout converts when paid, not when placed', async () => {
    const ctx = await store();
    const phone = nextPhone();
    const session = await request(app)
      .post(`/api/v1/store/${ctx.wid}/checkout-sessions`)
      .send({ visitorId: 'v-online-1', contact: { fullName: 'Late Payer', phone }, items: [{ variantId: ctx.variant.id, quantity: 1 }] });
    expect(session.status).toBe(200);
    const sessionId = session.body.session.id;

    const res = await checkout(ctx.wid, {
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Late Payer', phone },
      paymentMethod: 'card',
      returnUrl: RETURN_URL,
      checkoutSessionId: sessionId,
    });
    expect((await db.CheckoutSession.findByPk(sessionId)).status).not.toBe('converted');

    await payViaWebhook(ctx, { order: res.body.order, paymobOrderId: paymob.lastIntention().orderId });
    const converted = await db.CheckoutSession.findByPk(sessionId);
    expect(converted.status).toBe('converted');
    expect(converted.convertedOrderId).toBe(res.body.order.id);
  });
});

describe('return URL', () => {
  it('in production must point at the store', async () => {
    const ctx = await store();
    env.isProduction = true;
    try {
      const evil = await buyNow(ctx, { extra: { returnUrl: 'https://evil.example/steal' } });
      expect(evil.status).toBe(422);
      expect(evil.body.error.details[0].field).toBe('returnUrl');
      const ok = await buyNow(ctx, { extra: { returnUrl: `https://shop.${env.platformRootDomain}/pay/return` } });
      expect(ok.status).toBe(201);
    } finally {
      env.isProduction = false;
    }
  });
});
