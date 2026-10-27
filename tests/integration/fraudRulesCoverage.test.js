'use strict';

// Store fraud rules that had no test (max_items_per_order,
// min_minutes_between_cod_orders_per_ip, the to_lost and require_otp actions,
// phone_validation=strict), the checkout's quantity cap, IPv6 shoppers matched
// by their /64 (IPV6_PREFIX_RULES_ENABLED), the automations' risk level
// condition, and GET /fraud/capabilities.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const { storedOrder } = require('../helpers/storedOrder');
const { conditionsFail } = require('../../src/modules/automations/automationContext');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const key = () => `frc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let phoneSeq = 0;
const nextPhone = () => `0101${String(1000000 + (phoneSeq += 1)).padStart(7, '0')}`;
const address = { country: 'EG', city: 'Cairo', addressLine: '12 Coverage Street, Nasr City' };

function order(ctx, { phone = nextPhone(), quantity = 1, ip = '198.51.100.20', paymentMethod = 'cod', extra = {} } = {}) {
  return request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('X-Forwarded-For', ip)
    .set('Idempotency-Key', key())
    .send({
      item: { variantId: ctx.variant.id, quantity },
      contact: { fullName: 'Coverage Buyer', phone },
      shippingAddress: address,
      paymentMethod,
      ...extra,
    });
}

async function setRules(ctx, fraudRules) {
  const res = await request(app)
    .patch(`/api/v1/workspaces/${ctx.workspace.id}`)
    .set(bearer(ctx.auth.accessToken))
    .send({ settings: { fraud_rules: fraudRules } });
  if (res.status !== 200) throw new Error(`setRules failed: ${res.status} ${JSON.stringify(res.body)}`);
}

const lostOrders = (workspaceId) => db.CheckoutSession.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });

afterEach(() => {
  env.ipRules.ipv6Prefix = false;
  jest.restoreAllMocks();
});

describe('max_items_per_order', () => {
  it('flags an order with more units of one product than the rule allows, and only that one', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { max_items_per_order: { value: 3, action: 'flag' } });

    const atLimit = await order(ctx, { quantity: 3 });
    expect(atLimit.status).toBe(201);
    expect((await storedOrder(atLimit)).riskFlags).toEqual([]);

    const over = await order(ctx, { quantity: 4 });
    expect(over.status).toBe(201);
    expect((await storedOrder(over)).riskFlags).toContain('max_items_exceeded');
  });

  it('refuses it with "block": 422 ORDER_REJECTED and nothing reserved', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { max_items_per_order: { value: 2, action: 'block' } });

    const res = await order(ctx, { quantity: 5 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORDER_REJECTED');
    expect((await db.ProductVariant.findByPk(ctx.variant.id)).reservedStock).toBe(0);
    expect(await db.Order.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });
});

describe('min_minutes_between_cod_orders_per_ip', () => {
  it('flags a second COD order from the same IP inside the window, not one from another IP', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { min_minutes_between_cod_orders_per_ip: { value: 10, action: 'flag' } });

    const first = await order(ctx, { ip: '203.0.113.50' });
    const sameIp = await order(ctx, { ip: '203.0.113.50' });
    const otherIp = await order(ctx, { ip: '203.0.113.51' });
    expect([first.status, sameIp.status, otherIp.status]).toEqual([201, 201, 201]);
    expect((await storedOrder(first)).riskFlags).toEqual([]);
    expect((await storedOrder(sameIp)).riskFlags).toContain('ip_order_rate');
    expect((await storedOrder(otherIp)).riskFlags).toEqual([]);
  });

  it('refuses it with "block", and a cancelled order from that IP does not count', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { min_minutes_between_cod_orders_per_ip: { value: 10, action: 'block' } });

    const first = await order(ctx, { ip: '203.0.113.60' });
    expect(first.status).toBe(201);
    const second = await order(ctx, { ip: '203.0.113.60' });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('ORDER_REJECTED');

    await db.Order.update({ cancelledAt: new Date() }, { where: { id: first.body.order.id } });
    expect((await order(ctx, { ip: '203.0.113.60' })).status).toBe(201);
  });
});

describe('the to_lost action', () => {
  it('refuses like block, but keeps the checkout as a lost order waiting for the merchant', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { duplicate_window_minutes: { value: 60, action: 'to_lost' } });
    const phone = nextPhone();

    expect((await order(ctx, { phone })).status).toBe(201);
    const repeat = await order(ctx, { phone });
    expect(repeat.status).toBe(422);
    expect(repeat.body.error.code).toBe('ORDER_REJECTED');

    const lost = await lostOrders(ctx.workspace.id);
    expect(lost).toHaveLength(1);
    expect(lost[0].lostReason).toBe('limit_exceeded');
    expect(lost[0].reviewStatus).toBe('under_review');
  });

  it('"block" files its refusal as already reviewed', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { duplicate_window_minutes: { value: 60, action: 'block' } });
    const phone = nextPhone();
    await order(ctx, { phone });
    expect((await order(ctx, { phone })).status).toBe(422);
    const [lost] = await lostOrders(ctx.workspace.id);
    expect(lost.reviewStatus).toBe('completed');
  });
});

describe('the require_otp action', () => {
  it('asks for a code (428) when the rule fires; the order goes through with the proof, still flagged', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { duplicate_window_minutes: { value: 60, action: 'require_otp' } });
    const whatsapp = jest.spyOn(notify, 'whatsapp');
    const phone = nextPhone();

    expect((await order(ctx, { phone })).status).toBe(201);
    expect(whatsapp).not.toHaveBeenCalled();

    const challenged = await order(ctx, { phone });
    expect(challenged.status).toBe(428);
    expect(challenged.body.error.code).toBe('OTP_REQUIRED');
    expect(whatsapp).toHaveBeenCalledTimes(1);
    const { code } = whatsapp.mock.calls[0][0].data;

    const verified = await request(app).post(`/api/v1/store/${ctx.workspace.id}/checkout/otp/verify`).send({ phone, code });
    expect(verified.status).toBe(200);

    const placed = await order(ctx, { phone, extra: { otpToken: verified.body.otpToken } });
    expect(placed.status).toBe(201);
    expect((await storedOrder(placed)).riskFlags).toContain('duplicate_order');
  });
});

describe('phone_validation = strict', () => {
  it("refuses a number that is not a mobile of the store's country, tells the shopper, and keeps a lost order", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { phone_validation: 'strict' });

    // 013 is not an Egyptian mobile prefix; the Saudi number is a mobile, of another country.
    for (const phone of ['01312345678', '+966512345678']) {
      const res = await order(ctx, { phone });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_PHONE');
    }
    const lost = await lostOrders(ctx.workspace.id);
    expect(lost.map((l) => l.lostReason)).toEqual(['invalid_data', 'invalid_data']);

    expect((await order(ctx, { phone: '01012345678' })).status).toBe(201);
  });

  it('off (the default), the same numbers are only scored', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    const res = await order(ctx, { phone: '01312345678' });
    expect(res.status).toBe(201);
    expect((await storedOrder(res)).riskReasons).toContain('invalid_phone');
  });
});

describe('the checkout quantity cap', () => {
  it('refuses more than 1000 units of one Buy Now line', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 5000 });
    const res = await order(ctx, { quantity: 1001 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((await order(ctx, { quantity: 1000 })).status).toBe(201);
  });

  it('refuses a cart add over 1000, and a cart line grown past 1000 at checkout', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 5000 });
    const cart = await request(app).post(`/api/v1/store/${ctx.workspace.id}/cart`);
    const token = cart.body.guestToken;
    const add = (quantity) =>
      request(app).post(`/api/v1/store/${ctx.workspace.id}/cart/items`).set('X-Cart-Token', token).send({ variantId: ctx.variant.id, quantity });

    expect((await add(1001)).status).toBe(422);
    expect((await add(600)).status).toBeLessThan(300);
    expect((await add(401)).status).toBeLessThan(300);

    const res = await request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
      .set('X-Cart-Token', token)
      .set('Idempotency-Key', key())
      .send({ contact: { fullName: 'Cart Buyer', phone: nextPhone() }, shippingAddress: address, paymentMethod: 'cod' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('items.quantity');
  });
});

describe('IPv6 shoppers by their /64 (IPV6_PREFIX_RULES_ENABLED)', () => {
  it('min_minutes_between_cod_orders_per_ip: the same /64 counts with the flag on, not with it off', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { min_minutes_between_cod_orders_per_ip: { value: 10, action: 'flag' } });

    expect((await order(ctx, { ip: '2001:db8:10:20::1' })).status).toBe(201);
    const off = await order(ctx, { ip: '2001:db8:10:20::2' });
    expect((await storedOrder(off)).riskFlags).toEqual([]);

    env.ipRules.ipv6Prefix = true;
    const sameLine = await order(ctx, { ip: '2001:db8:10:20:abcd::3' });
    expect((await storedOrder(sameLine)).riskFlags).toContain('ip_order_rate');
    const otherLine = await order(ctx, { ip: '2001:db8:10:21::1' });
    expect((await storedOrder(otherLine)).riskFlags).toEqual([]);
    // IPv4 is compared whole either way.
    expect((await order(ctx, { ip: '198.51.100.70' })).status).toBe(201);
    const v4 = await order(ctx, { ip: '198.51.100.71' });
    expect((await storedOrder(v4)).riskFlags).toEqual([]);
  });

  it('a blocked IPv6 address blocks its /64 with the flag on', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    await setRules(ctx, { block_blacklisted: true });
    const blocked = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/fraud/blocklist`)
      .set(bearer(ctx.auth.accessToken))
      .send({ type: 'ip', value: '2001:db8:5:6::1', scopes: ['orders'] });
    expect(blocked.status).toBe(201);

    expect((await order(ctx, { ip: '2001:db8:5:6::99' })).status).toBe(201);
    expect((await order(ctx, { ip: '2001:db8:5:6::1' })).status).toBe(422);

    env.ipRules.ipv6Prefix = true;
    const res = await order(ctx, { ip: '2001:db8:5:6::99' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ORDER_REJECTED');
    expect((await order(ctx, { ip: '2001:db8:5:7::1' })).status).toBe(201);
  });

  it("ip_burst counts the /64's orders of the hour with the flag on", async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 50 });
    env.ipRules.ipv6Prefix = true;
    await order(ctx, { ip: '2001:db8:7:8::1' });
    await order(ctx, { ip: '2001:db8:7:8::2' });
    const third = await order(ctx, { ip: '2001:db8:7:8::3' });
    expect((await storedOrder(third)).riskReasons).toContain('ip_burst');

    env.ipRules.ipv6Prefix = false;
    const fourth = await order(ctx, { ip: '2001:db8:7:8::4' });
    expect((await storedOrder(fourth)).riskReasons).not.toContain('ip_burst');
  });
});

describe('automations: the risk level condition', () => {
  it('saves "medium" as "moderate" and matches moderate orders', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 5 });
    const created = await request(app)
      .post(`/api/v1/workspaces/${ctx.workspace.id}/automations`)
      .set(bearer(ctx.auth.accessToken))
      .send({
        name: 'Risky orders',
        trigger: 'order.created',
        conditions: { riskLevel: ['medium', 'high'] },
        actions: [{ type: 'notify_team', message: 'Check this order' }],
      });
    expect(created.status).toBe(201);
    const rule = await db.AutomationRule.findByPk(created.body.rule.id);
    expect(rule.conditions.riskLevel).toEqual(['moderate', 'high']);

    const subject = (riskLevel) => ({ kind: 'order', order: { workspaceId: ctx.workspace.id, riskLevel } });
    expect(await conditionsFail({ riskLevel: ['moderate'] }, subject('moderate'))).toBeNull();
    // A rule saved before with the old name still matches.
    expect(await conditionsFail({ riskLevel: ['medium'] }, subject('moderate'))).toBeNull();
    expect(await conditionsFail({ riskLevel: ['moderate'] }, subject('low'))).toBe('risk level is low');
  });
});

describe('GET /fraud/capabilities', () => {
  const saved = process.env.BOT_PROTECTION_DEFAULT;
  afterEach(() => {
    if (saved === undefined) delete process.env.BOT_PROTECTION_DEFAULT;
    else process.env.BOT_PROTECTION_DEFAULT = saved;
    env.visitorGate.enabled = false;
  });

  it('says what the platform can act on: no IP lookup, no challenge, no network rate', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    delete process.env.BOT_PROTECTION_DEFAULT;
    const res = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/fraud/capabilities`).set(bearer(ctx.auth.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      botProtection: { platformDefault: false },
      ipIntel: { provider: null },
      captcha: { provider: null },
      visitorGate: { enabled: false },
      networkDeliveryRate: { available: false },
      checkoutOtp: { guard: false, whatsapp: true, sms: true },
    });

    process.env.BOT_PROTECTION_DEFAULT = 'on';
    env.visitorGate.enabled = true;
    const on = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/fraud/capabilities`).set(bearer(ctx.auth.accessToken));
    expect(on.body.botProtection.platformDefault).toBe(true);
    expect(on.body.visitorGate.enabled).toBe(true);
  });

  it('is for the store\'s own team only', async () => {
    const a = await setupWorkspaceWithProduct({ stock: 1 });
    const b = await setupWorkspaceWithProduct({ stock: 1 });
    expect((await request(app).get(`/api/v1/workspaces/${a.workspace.id}/fraud/capabilities`)).status).toBe(401);
    expect((await request(app).get(`/api/v1/workspaces/${a.workspace.id}/fraud/capabilities`).set(bearer(b.auth.accessToken))).status).toBe(404);
  });
});
