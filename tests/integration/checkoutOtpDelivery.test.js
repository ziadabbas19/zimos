'use strict';

// Checkout phone codes that cannot arrive (risk/checkoutOtp,
// CHECKOUT_OTP_DELIVERY_GUARD_ENABLED): switching them on is refused while no
// channel delivers, and a code that reached no channel lets the order through,
// marked otp_unavailable, instead of stopping the checkout.
//
// "No channel" here: WhatsApp on the platform number with no number set up,
// SMS on Twilio with no credentials. Neither reaches the network: both fail
// before a request is made.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { storedOrder } = require('../helpers/storedOrder');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `otpd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let phoneSeq = 0;
const nextPhone = () => `0102${String(1000000 + (phoneSeq += 1)).padStart(7, '0')}`;

const saved = {
  checkoutOtp: { ...env.checkoutOtp },
  sms: { ...env.sms },
  smsProvider: env.notifications.smsProvider,
  whatsappProvider: env.notifications.whatsappProvider,
  twilio: { ...env.notifications.twilio },
};
afterEach(() => {
  Object.assign(env.checkoutOtp, saved.checkoutOtp);
  Object.assign(env.sms, saved.sms);
  env.notifications.smsProvider = saved.smsProvider;
  env.notifications.whatsappProvider = saved.whatsappProvider;
  Object.assign(env.notifications.twilio, saved.twilio);
  delete process.env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_PLATFORM_TOKEN;
});

function noChannel() {
  env.notifications.whatsappProvider = 'cloud';
  delete process.env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_PLATFORM_TOKEN;
  env.notifications.smsProvider = 'twilio';
  Object.assign(env.notifications.twilio, { accountSid: '', authToken: '', fromNumber: '' });
}

// Twilio set up (never called: these tests only save settings with it).
function smsReady() {
  env.notifications.smsProvider = 'twilio';
  Object.assign(env.notifications.twilio, { accountSid: 'AC-test-only', authToken: 'test-only-token', fromNumber: '+15550000000' });
}

const patchRules = (ctx, fraudRules) =>
  request(app).patch(`/api/v1/workspaces/${ctx.workspace.id}`).set(bearer(ctx.auth.accessToken)).send({ settings: { fraud_rules: fraudRules } });

async function storeWith(fraudRules) {
  const ctx = await setupWorkspaceWithProduct({ stock: 50 });
  const workspace = await db.Workspace.findByPk(ctx.workspace.id);
  await workspace.update({ settings: { ...(workspace.settings || {}), fraud_rules: fraudRules } });
  return ctx;
}

const checkout = (ctx, { phone = nextPhone(), fullName = 'Delivery Guard Buyer' } = {}) =>
  request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', key())
    .send({
      item: { variantId: ctx.variant.id, quantity: 1 },
      contact: { fullName, phone },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '5 Guard Street, Heliopolis' },
      paymentMethod: 'cod',
    });

const OTP_ALL = { checkout_otp: { enabled: true, channel: 'whatsapp', apply_to: 'all', code_length: 4 } };

async function undeliveredAlerts(workspaceId) {
  // The alert is written after the answer; give it a moment.
  for (let i = 0; i < 20; i += 1) {
    const rows = await db.MerchantNotification.findAll({ where: { workspaceId, type: 'integration.failed' } });
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

describe('switching codes on (guard on)', () => {
  beforeEach(() => {
    env.checkoutOtp.deliveryGuard = true;
  });

  it('is refused while no channel can deliver, and nothing is saved', async () => {
    noChannel();
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    const res = await patchRules(ctx, OTP_ALL);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OTP_CHANNEL_UNAVAILABLE');
    expect(res.body.error.details[0]).toMatchObject({ field: 'settings.fraud_rules.checkout_otp', channel: 'whatsapp' });
    const workspace = await db.Workspace.findByPk(ctx.workspace.id);
    expect(((workspace.settings || {}).fraud_rules || {}).checkout_otp).toBeUndefined();
  });

  it('a rule whose action asks for a code is refused the same way', async () => {
    noChannel();
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    const res = await patchRules(ctx, { duplicate_window_minutes: { value: 60, action: 'require_otp' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OTP_CHANNEL_UNAVAILABLE');
    expect((await patchRules(ctx, { duplicate_window_minutes: { value: 60, action: 'flag' } })).status).toBe(200);
  });

  it('SMS that delivers is enough, for SMS codes and for WhatsApp codes (their fallback)', async () => {
    noChannel();
    smsReady();
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    expect((await patchRules(ctx, { checkout_otp: { ...OTP_ALL.checkout_otp, channel: 'sms' } })).status).toBe(200);
    expect((await patchRules(ctx, OTP_ALL)).status).toBe(200);
  });

  it('what was already on is not refused again when other rules are saved', async () => {
    noChannel();
    const ctx = await storeWith(OTP_ALL);
    const res = await patchRules(ctx, { ...OTP_ALL, max_orders_per_phone_per_day: { value: 3, action: 'flag' } });
    expect(res.status).toBe(200);
  });

  it('off: switching codes on is saved whatever the channels, as before', async () => {
    env.checkoutOtp.deliveryGuard = false;
    noChannel();
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    expect((await patchRules(ctx, OTP_ALL)).status).toBe(200);
  });
});

describe('a code that reaches no channel (guard on)', () => {
  beforeEach(() => {
    env.checkoutOtp.deliveryGuard = true;
  });

  it('lets the order through, marked, with no code row and no lost order; the store is told once', async () => {
    noChannel();
    const ctx = await storeWith(OTP_ALL);

    const first = await checkout(ctx);
    expect(first.status).toBe(201);
    const order = await storedOrder(first);
    expect(order.riskFlags).toContain('otp_unavailable');
    expect(order.riskReasons).toContain('otp_unavailable');
    expect(order.riskLevel).toBe('low');
    expect(await db.OtpCode.count()).toBe(0);
    expect(await db.CheckoutSession.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);

    expect((await checkout(ctx)).status).toBe(201);
    const alerts = await undeliveredAlerts(ctx.workspace.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].dedupeKey).toMatch(/^integration\.failed:checkout_otp:/);
    expect(alerts[0].link).toBe('/fraud');
  });

  it('a risky order asked for a code inside the order (risky_only) is placed once, marked', async () => {
    noChannel();
    const ctx = await storeWith({ checkout_otp: { enabled: true, channel: 'whatsapp', apply_to: 'risky_only', code_length: 4 } });
    // 013 is not a mobile prefix: +40, a moderate order.
    const res = await checkout(ctx, { phone: '01312345678' });
    expect(res.status).toBe(201);
    expect(await db.Order.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);
    const order = await storedOrder(res);
    expect(order.riskFlags).toContain('otp_unavailable');
    expect(order.riskLevel).toBe('moderate');
  });

  it('an SMS refused by SMS_ALLOWED_COUNTRIES counts as not delivered', async () => {
    env.sms.allowedCallingCodes = ['966'];
    const ctx = await storeWith({ checkout_otp: { ...OTP_ALL.checkout_otp, channel: 'sms' } });
    const res = await checkout(ctx);
    expect(res.status).toBe(201);
    expect((await storedOrder(res)).riskFlags).toContain('otp_unavailable');
  });

  it('a code that did leave still asks for it (428), as before', async () => {
    const ctx = await storeWith(OTP_ALL);
    const res = await checkout(ctx);
    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('OTP_REQUIRED');
    expect(await db.OtpCode.count()).toBe(1);
  });
});

describe('guard off (the default)', () => {
  it('a code that reached no channel still answers 428 and files the checkout as unverified, as before', async () => {
    noChannel();
    const ctx = await storeWith(OTP_ALL);
    const res = await checkout(ctx);
    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('OTP_REQUIRED');
    expect(await db.Order.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
    const [lost] = await db.CheckoutSession.findAll({ where: { workspaceId: ctx.workspace.id } });
    expect(lost.awaitingOtp).toBe(true);
  });
});
