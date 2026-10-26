'use strict';

/**
 * Loyalty points as a plan feature and the guard (loyalty/loyaltyAccess.js):
 * LOYALTY_REQUIRE_PLAN_FEATURE (with PLAN_FEATURE_ENFORCEMENT) freezes a
 * store whose features lack `loyalty`; LOYALTY_GUARD_ENABLED freezes a
 * lapsed one, keeps blocked customers out and stops one device spending
 * several accounts' points. Frozen points are kept and shown, never earned,
 * spent or expired. Also: the per-order cap, and no points on a locked order.
 */

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const loyalty = require('../../src/modules/loyalty/loyaltyService');

const DAY = 864e5;
const ORIGINAL = {
  gate: env.loyalty.requirePlanFeature,
  guard: env.loyalty.guard,
  enforcement: env.planFeatures.enforcement,
  ordersLock: env.ordersLock.enabled,
};

afterEach(() => {
  env.storeFeatures.length = 0;
  env.loyalty.requirePlanFeature = ORIGINAL.gate;
  env.loyalty.guard = ORIGINAL.guard;
  env.planFeatures.enforcement = ORIGINAL.enforcement;
  env.ordersLock.enabled = ORIGINAL.ordersLock;
  jest.restoreAllMocks();
});
beforeEach(() => {
  env.storeFeatures.push('shopper_accounts', 'loyalty');
});

const PROGRAM = { enabled: true, earnPointsPerUnit: 1, pointValue: 10, minRedeemPoints: 10, maxRedeemPercent: 50, expiryDays: 365 };
const gateOn = () => {
  env.loyalty.requirePlanFeature = true;
  env.planFeatures.enforcement = true;
};

async function planWith(features) {
  return db.Plan.create({ key: `loy-${crypto.randomBytes(4).toString('hex')}`, name: 'Plan', currency: 'EGP', monthlyPriceAmount: 10000, yearlyPriceAmount: 100000, trialDays: 14, isActive: true, isPublic: true, features });
}

async function signIn(wid, phone) {
  const sms = jest.spyOn(notify, 'sms');
  await request(app).post(`/api/v1/store/${wid}/account/code`).send({ phone });
  const code = sms.mock.calls.map(([o]) => o).filter((o) => o.data && o.data.code).pop().data.code;
  sms.mockRestore();
  const signed = await request(app).post(`/api/v1/store/${wid}/account/verify`).send({ phone, code });
  return { T: { 'X-Shopper-Token': signed.body.token }, customerId: signed.body.customer.id, phone };
}

/** A store with the programme saved, its plan listing `features`, and a signed-in shopper. */
async function store({ features = [], phone = '01015150001', program = PROGRAM } = {}) {
  const ctx = await setupWorkspaceWithProduct({ price: 10000 });
  const wid = ctx.workspace.id;
  const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
  await db.Subscription.update({ planId: (await planWith(features)).id }, { where: { workspaceId: wid } });
  await request(app).put(`/api/v1/workspaces/${wid}/shopper-accounts`).set(H).send({ enabled: true });
  const shopper = await signIn(wid, phone);
  const ws = await db.Workspace.findByPk(wid);
  await ws.update({ settings: { ...ws.settings, loyalty: program } });
  const buy = (who, body = {}) =>
    request(app)
      .post(`/api/v1/store/${wid}/checkout`)
      .set('Idempotency-Key', `loya-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .set('User-Agent', 'Mozilla/5.0 (test)')
      .set(who ? who.T : {})
      .send({ item: { variantId: ctx.variant.id, quantity: 1 }, contact: { fullName: 'Points Shopper', phone: who ? who.phone : phone }, paymentMethod: 'cod', ...body });
  const deliver = (orderId) => loyalty.earnForOrder({ type: 'order.delivered', workspaceId: wid, payload: { orderId } });
  const delivered = async (who = shopper) => {
    const placed = await buy(who);
    if (placed.status !== 201) throw new Error(`checkout failed: ${placed.status} ${JSON.stringify(placed.body)}`);
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: placed.body.order.id } });
    await deliver(placed.body.order.id);
    return placed.body.order.id;
  };
  return { ...ctx, wid, H, shopper, buy, deliver, delivered };
}

const pointsOf = async (id) => (await db.Customer.findByPk(id)).loyaltyPoints;
const overview = async (s) => (await request(app).get(`/api/v1/workspaces/${s.wid}/loyalty`).set(s.H)).body;
const save = (s, body) => request(app).put(`/api/v1/workspaces/${s.wid}/loyalty`).set(s.H).send(body);
const account = async (s, who = s.shopper) => (await request(app).get(`/api/v1/store/${s.wid}/account/loyalty`).set(who.T)).body;
const program = async (s) => (await request(app).get(`/api/v1/store/${s.wid}/loyalty`)).body.program;

describe('the switches off (the default)', () => {
  it('start off under the suite; with PLAN_FEATURE_ENFORCEMENT on, a plan without loyalty still earns, spends and saves', async () => {
    expect(env.loyalty.requirePlanFeature).toBe(false);
    expect(env.loyalty.guard).toBe(false);
    env.planFeatures.enforcement = true;
    const s = await store();
    expect(await overview(s)).toMatchObject({ planLocked: false, frozen: false, frozenReason: null, active: true });
    await s.delivered();
    expect(await pointsOf(s.shopper.customerId)).toBe(100);
    expect((await s.buy(s.shopper, { loyaltyPoints: 20 })).body.loyalty).toMatchObject({ applied: true, points: 20 });
    expect((await save(s, PROGRAM)).status).toBe(200);
    expect(await account(s)).toMatchObject({ frozen: false, program: { pointValue: 10 } });
  });

  it('LOYALTY_REQUIRE_PLAN_FEATURE alone (enforcement off) locks nothing', async () => {
    env.loyalty.requirePlanFeature = true;
    const s = await store({ phone: '01015150002' });
    expect(await overview(s)).toMatchObject({ planLocked: false, frozen: false });
    expect((await save(s, PROGRAM)).status).toBe(200);
  });
});

describe('LOYALTY_REQUIRE_PLAN_FEATURE with PLAN_FEATURE_ENFORCEMENT', () => {
  it('a plan without loyalty: switching on is refused, points are frozen but kept and shown', async () => {
    gateOn();
    const s = await store({ features: ['funnels'], phone: '01015150003' });
    await db.Customer.update({ loyaltyPoints: 300 }, { where: { id: s.shopper.customerId } });

    expect(await overview(s)).toMatchObject({ planLocked: true, frozen: true, frozenReason: 'plan', outstandingPoints: 300 });

    const refused = await save(s, PROGRAM);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    expect(refused.body.error.details).toEqual({ feature: 'loyalty', label: { en: 'Loyalty points', ar: 'نقاط الولاء' } });
    // Saving it off passes on any plan.
    expect((await save(s, { ...PROGRAM, enabled: false })).status).toBe(200);
    const ws = await db.Workspace.findByPk(s.wid);
    await ws.update({ settings: { ...ws.settings, loyalty: PROGRAM } });

    // Not earned, not spent, still there.
    await s.delivered();
    expect(await pointsOf(s.shopper.customerId)).toBe(300);
    const spend = await s.buy(s.shopper, { loyaltyPoints: 50 });
    expect(spend.status).toBe(422);
    expect(spend.body.error.code).toBe('LOYALTY_FROZEN');
    expect(spend.body.error.details).toEqual([{ field: 'loyaltyPoints', message: expect.any(String) }]);
    expect(await pointsOf(s.shopper.customerId)).toBe(300);

    // The shopper sees the balance, with no programme to use it in.
    expect(await program(s)).toBeNull();
    expect(await account(s)).toMatchObject({ balance: 300, frozen: true, expiresAt: null, program: null });

    // The merchant's customer card shows it too.
    const card = await request(app).get(`/api/v1/workspaces/${s.wid}/loyalty/customers/${s.shopper.customerId}`).set(s.H);
    expect(card.body).toMatchObject({ balance: 300, frozen: true });
  });

  it('frozen balances never expire, and get a whole expiry again once the feature is back', async () => {
    gateOn();
    const s = await store({ features: [], phone: '01015150004' });
    await db.Customer.update({ loyaltyPoints: 200, loyaltyActivityAt: new Date(Date.now() - 400 * DAY) }, { where: { id: s.shopper.customerId } });

    await loyalty.expireInactive();
    expect(await pointsOf(s.shopper.customerId)).toBe(200);
    const marked = (await db.Workspace.findByPk(s.wid)).settings.loyalty.frozenSeenAt;
    expect(new Date(marked).getTime()).toBeGreaterThan(Date.now() - 60 * 1000);

    // A console grant gives the feature back: still not expired the next day, and expiry is a year from the mark.
    await db.WorkspaceFeatureOverride.create({ workspaceId: s.wid, featureKey: 'loyalty', mode: 'grant', reason: 'test' });
    await loyalty.expireInactive();
    expect(await pointsOf(s.shopper.customerId)).toBe(200);
    const shown = await account(s);
    expect(shown.frozen).toBe(false);
    expect(new Date(shown.expiresAt).getTime()).toBeGreaterThan(Date.now() + 360 * DAY);
    // The settings route never echoes nor takes the mark.
    expect((await overview(s)).settings.frozenSeenAt).toBeUndefined();
  });

  it('a plan listing loyalty, or a console grant, runs as before', async () => {
    gateOn();
    const s = await store({ features: ['loyalty'], phone: '01015150005' });
    expect(await overview(s)).toMatchObject({ planLocked: false, frozen: false });
    expect((await save(s, PROGRAM)).status).toBe(200);
    await s.delivered();
    expect(await pointsOf(s.shopper.customerId)).toBe(100);

    const g = await store({ features: [], phone: '01015150006' });
    await db.WorkspaceFeatureOverride.create({ workspaceId: g.wid, featureKey: 'loyalty', mode: 'grant', reason: 'test' });
    expect(await overview(g)).toMatchObject({ planLocked: false, frozen: false });
    await g.delivered();
    expect(await pointsOf(g.shopper.customerId)).toBe(100);
    expect((await g.buy(g.shopper, { loyaltyPoints: 30 })).body.loyalty).toMatchObject({ applied: true, points: 30 });
  });

  it('a plan change between the checkout check and the spend leaves the order unpaid by points', async () => {
    gateOn();
    const s = await store({ features: ['loyalty'], phone: '01015150007' });
    await db.Customer.update({ loyaltyPoints: 100 }, { where: { id: s.shopper.customerId } });
    const placed = await s.buy();
    await db.Subscription.update({ planId: (await planWith([])).id }, { where: { workspaceId: s.wid } });
    const order = await db.Order.findByPk(placed.body.order.id);
    expect(await loyalty.spendOnOrder(order, s.shopper.customerId, 50)).toEqual({ applied: false, reason: 'frozen' });
    expect(await pointsOf(s.shopper.customerId)).toBe(100);
  });
});

describe('LOYALTY_GUARD_ENABLED', () => {
  it('a subscription unpaid past its grace day freezes the points; renewing runs them again', async () => {
    env.loyalty.guard = true;
    const s = await store({ phone: '01015150008' });
    const orderId = (await s.buy()).body.order.id;
    await db.Subscription.update({ status: 'active', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() - 3 * DAY) }, { where: { workspaceId: s.wid } });

    expect(await overview(s)).toMatchObject({ planLocked: false, frozen: true, frozenReason: 'subscription' });
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: orderId } });
    await s.deliver(orderId);
    expect(await pointsOf(s.shopper.customerId)).toBe(0);

    await db.Subscription.update({ currentPeriodEnd: new Date(Date.now() + 20 * DAY) }, { where: { workspaceId: s.wid } });
    expect(await overview(s)).toMatchObject({ frozen: false });
    await s.deliver(orderId);
    expect(await pointsOf(s.shopper.customerId)).toBe(100);
  });

  it('a blocked customer earns nothing and spends nothing', async () => {
    env.loyalty.guard = true;
    const s = await store({ phone: '01015150009' });
    const orderId = (await s.buy()).body.order.id;
    await db.Customer.update({ loyaltyPoints: 80, isBlacklisted: true }, { where: { id: s.shopper.customerId } });
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: orderId } });
    await s.deliver(orderId);
    expect(await pointsOf(s.shopper.customerId)).toBe(80);
    // The checkout's own check refuses the points (the store's fraud rules may refuse the order itself first).
    const workspace = await db.Workspace.findByPk(s.wid);
    const customer = await db.Customer.findByPk(s.shopper.customerId);
    await expect(loyalty.assertCanSpend(workspace, customer, 20)).rejects.toMatchObject({ code: 'LOYALTY_UNAVAILABLE', statusCode: 422 });
    await s.buy(s.shopper, { loyaltyPoints: 20 });
    expect(await pointsOf(s.shopper.customerId)).toBe(80);
    // Off, the same customer may spend.
    env.loyalty.guard = false;
    await expect(loyalty.assertCanSpend(workspace, customer, 20)).resolves.toBe(customer);
  });

  it("one device can't spend a second account's points within 24 hours; the first account still can", async () => {
    env.loyalty.guard = true;
    const s = await store({ phone: '01015150010' });
    const other = await signIn(s.wid, '01015150011');
    await db.Customer.update({ loyaltyPoints: 100 }, { where: { id: [s.shopper.customerId, other.customerId] } });
    const device = { deviceId: 'device-abcdef-123456' };

    expect((await s.buy(s.shopper, { loyaltyPoints: 20, ...device })).body.loyalty).toMatchObject({ applied: true });
    const second = await s.buy(other, { loyaltyPoints: 20, ...device });
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('LOYALTY_DEVICE_LIMIT');
    expect(await pointsOf(other.customerId)).toBe(100);
    // Another device, or the same account again, passes.
    expect((await s.buy(other, { loyaltyPoints: 20, deviceId: 'device-zzzzzz-999999' })).body.loyalty).toMatchObject({ applied: true });
    expect((await s.buy(s.shopper, { loyaltyPoints: 20, ...device })).body.loyalty).toMatchObject({ applied: true });

    // Off, the same two spends pass.
    env.loyalty.guard = false;
    const off = await store({ phone: '01015150012' });
    const otherOff = await signIn(off.wid, '01015150013');
    await db.Customer.update({ loyaltyPoints: 100 }, { where: { id: [off.shopper.customerId, otherOff.customerId] } });
    expect((await off.buy(off.shopper, { loyaltyPoints: 20, ...device })).body.loyalty).toMatchObject({ applied: true });
    expect((await off.buy(otherOff, { loyaltyPoints: 20, ...device })).body.loyalty).toMatchObject({ applied: true });
  });
});

describe('the per-order cap and locked orders', () => {
  it('maxRedeemPointsPerOrder caps what one order takes; saved and shown to shoppers; empty = no cap', async () => {
    const s = await store({ phone: '01015150014' });
    const saved = await save(s, { ...PROGRAM, maxRedeemPointsPerOrder: 25 });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.maxRedeemPointsPerOrder).toBe(25);
    expect(await program(s)).toMatchObject({ maxRedeemPointsPerOrder: 25 });
    await db.Customer.update({ loyaltyPoints: 100 }, { where: { id: s.shopper.customerId } });
    expect((await s.buy(s.shopper, { loyaltyPoints: 40 })).body.loyalty).toMatchObject({ applied: true, points: 25, amount: '250' });
    expect(await pointsOf(s.shopper.customerId)).toBe(75);

    expect((await save(s, { ...PROGRAM, maxRedeemPointsPerOrder: null })).body.settings.maxRedeemPointsPerOrder).toBeNull();
    expect((await save(s, { ...PROGRAM, maxRedeemPointsPerOrder: 0 })).status).toBe(422);
  });

  it('an order locked when delivered (ORDERS_LOCK_ENABLED, lapsed store) earns nothing', async () => {
    env.ordersLock.enabled = true;
    const s = await store({ phone: '01015150015' });
    await db.Subscription.update({ status: 'active', trialEndsAt: null, currentPeriodEnd: new Date(Date.now() - 3 * DAY) }, { where: { workspaceId: s.wid } });
    const locked = await s.buy();
    expect(locked.status).toBe(201);
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: locked.body.order.id } });
    await s.deliver(locked.body.order.id);
    expect(await pointsOf(s.shopper.customerId)).toBe(0);

    // Renewed: a delivered order earns again.
    await db.Subscription.update({ currentPeriodEnd: new Date(Date.now() + 20 * DAY) }, { where: { workspaceId: s.wid } });
    await s.delivered();
    expect(await pointsOf(s.shopper.customerId)).toBe(100);
  });
});
