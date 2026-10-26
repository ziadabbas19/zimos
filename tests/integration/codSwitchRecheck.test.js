'use strict';

// Switching an online order to cash on delivery (onlinePaymentService.switchToCod)
// with COD_SWITCH_RECHECK_ENABLED: each fired rule's own action, and the phone
// code a COD checkout would have asked for. Paymob is the fake in helpers/fakePaymob.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const fake = require('../helpers/fakePaymob');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let phoneSeq = 0;
const nextPhone = () => `0104${String(1000000 + (phoneSeq += 1)).padStart(7, '0')}`;
const RETURN_URL = 'http://localhost:3001/store/x/pay/return';

const original = { payments: { ...env.payments }, codSwitch: { ...env.codSwitch }, checkoutOtp: { ...env.checkoutOtp } };
const savedProviders = { sms: env.notifications.smsProvider, whatsapp: env.notifications.whatsappProvider, twilio: { ...env.notifications.twilio } };

beforeEach(() => {
  env.payments.onlineEnabled = true;
  env.payments.credentialsKey = fake.newKey();
  fake.install();
});

afterEach(() => {
  Object.assign(env.payments, original.payments);
  Object.assign(env.codSwitch, original.codSwitch);
  Object.assign(env.checkoutOtp, original.checkoutOtp);
  env.notifications.smsProvider = savedProviders.sms;
  env.notifications.whatsappProvider = savedProviders.whatsapp;
  Object.assign(env.notifications.twilio, savedProviders.twilio);
  jest.restoreAllMocks();
});

async function store(fraudRules) {
  const setup = await setupWorkspaceWithProduct({ price: 20000, stock: 20 });
  const res = await request(app)
    .put(`/api/v1/workspaces/${setup.workspace.id}/payments/gateways/paymob`)
    .set(bearer(setup.auth.accessToken))
    .send({ credentials: fake.credentials('live'), settings: { cardIntegrationId: 111, walletIntegrationId: 222 } });
  if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${JSON.stringify(res.body)}`);
  await db.Workspace.update({ settings: { fraud_rules: fraudRules } }, { where: { id: setup.workspace.id } });
  return { ...setup, wid: setup.workspace.id };
}

const place = (ctx, phone, paymentMethod) =>
  request(app)
    .post(`/api/v1/store/${ctx.wid}/checkout`)
    .set('Idempotency-Key', `cs-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName: 'Switching Shopper', phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '9 Switch Street, Maadi', province: 'Cairo' },
      paymentMethod,
      ...(paymentMethod === 'cod' ? {} : { returnUrl: RETURN_URL }),
    });

const switchToCod = (ctx, online, body = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.wid}/orders/${online.body.order.id}/payment/switch-to-cod`)
    .set('X-Payment-Token', online.body.paymentToken)
    .send(body);

/** A COD order, then an online one from the same phone: the online one carries duplicate_order. */
async function repeatOnline(ctx) {
  const phone = nextPhone();
  expect((await place(ctx, phone, 'cod')).status).toBe(201);
  const online = await place(ctx, phone, 'card');
  expect(online.status).toBe(201);
  expect((await db.Order.findByPk(online.body.order.id)).riskFlags).toContain('duplicate_order');
  return online;
}

const paymentMethodOf = async (online) => (await db.Order.findByPk(online.body.order.id)).paymentMethod;

describe('a rule whose own action refuses', () => {
  it('off: only the store-wide "block" refuses, so the switch goes through, as before', async () => {
    const ctx = await store({ duplicate_window_minutes: { value: 60, action: 'block' } });
    const online = await repeatOnline(ctx);
    const res = await switchToCod(ctx, online);
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('cod');
  });

  it('on: "block" refuses the switch and the order keeps waiting for its payment', async () => {
    env.codSwitch.recheck = true;
    const ctx = await store({ duplicate_window_minutes: { value: 60, action: 'block' } });
    const online = await repeatOnline(ctx);
    const res = await switchToCod(ctx, online);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORDER_REJECTED');
    expect(await paymentMethodOf(online)).toBe('card');
  });

  it('on: "to_lost" refuses it too', async () => {
    env.codSwitch.recheck = true;
    const ctx = await store({ duplicate_window_minutes: { value: 60, action: 'to_lost' } });
    const online = await repeatOnline(ctx);
    expect((await switchToCod(ctx, online)).status).toBe(422);
  });

  it('on: a rule whose own action is "flag" lets it through even when the store-wide action is "block"', async () => {
    env.codSwitch.recheck = true;
    const ctx = await store({ action: 'block', duplicate_window_minutes: { value: 60, action: 'flag' } });
    const phone = nextPhone();
    expect((await place(ctx, phone, 'cod')).status).toBe(201);
    const online = await place(ctx, phone, 'card');
    expect((await switchToCod(ctx, online)).status).toBe(200);
  });
});

describe('the phone code a COD checkout would have asked for (on)', () => {
  beforeEach(() => {
    env.codSwitch.recheck = true;
  });

  it('a fired rule asking for a code: 428 with the code sent, a wrong code refused, the right one switches', async () => {
    const ctx = await store({ duplicate_window_minutes: { value: 60, action: 'require_otp' } });
    const online = await repeatOnline(ctx);
    const whatsapp = jest.spyOn(notify, 'whatsapp');

    const asked = await switchToCod(ctx, online);
    expect(asked.status).toBe(428);
    expect(asked.body.error.code).toBe('OTP_REQUIRED');
    expect(asked.body.error.details.phoneHint).toMatch(/\d{4}$/);
    expect(whatsapp).toHaveBeenCalledTimes(1);
    const { code } = whatsapp.mock.calls[0][0].data;
    expect(await paymentMethodOf(online)).toBe('card');

    const wrong = await switchToCod(ctx, online, { otpCode: code === '0000' ? '1111' : '0000' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('INVALID_CODE');

    const right = await switchToCod(ctx, online, { otpCode: code });
    expect(right.status).toBe(200);
    expect(right.body.payment.status).toBe('cod');
  });

  it('a store sending codes for every COD order asks at the switch (the online checkout did not)', async () => {
    const ctx = await store({ checkout_otp: { enabled: true, channel: 'whatsapp', apply_to: 'cod_only', code_length: 4 } });
    const online = await place(ctx, nextPhone(), 'card');
    expect(online.status).toBe(201);
    const res = await switchToCod(ctx, online);
    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('OTP_REQUIRED');
  });

  it('"all" was asked at checkout already: the switch asks nothing more', async () => {
    const ctx = await store({});
    const online = await place(ctx, nextPhone(), 'card');
    await db.Workspace.update(
      { settings: { fraud_rules: { checkout_otp: { enabled: true, channel: 'whatsapp', apply_to: 'all', code_length: 4 } } } },
      { where: { id: ctx.wid } }
    );
    expect((await switchToCod(ctx, online)).status).toBe(200);
  });

  it('with the delivery guard, a code that reached no channel lets the switch through, marked', async () => {
    env.checkoutOtp.deliveryGuard = true;
    const ctx = await store({ checkout_otp: { enabled: true, channel: 'whatsapp', apply_to: 'cod_only', code_length: 4 } });
    const online = await place(ctx, nextPhone(), 'card');
    env.notifications.whatsappProvider = 'cloud';
    env.notifications.smsProvider = 'twilio';
    Object.assign(env.notifications.twilio, { accountSid: '', authToken: '', fromNumber: '' });

    const res = await switchToCod(ctx, online);
    expect(res.status).toBe(200);
    const order = await db.Order.findByPk(online.body.order.id);
    expect(order.paymentMethod).toBe('cod');
    expect(order.riskFlags).toContain('otp_unavailable');
  });
});

it('off: a store sending codes for COD orders still switches without one, as before', async () => {
  const ctx = await store({ checkout_otp: { enabled: true, channel: 'whatsapp', apply_to: 'cod_only', code_length: 4 } });
  const online = await place(ctx, nextPhone(), 'card');
  expect((await switchToCod(ctx, online)).status).toBe(200);
});
