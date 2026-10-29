'use strict';

// GET /plans/public (billing/publicPlansService): the plans on the marketing
// site and at sign-up — active and public only, ordered by display_order,
// nothing internal — the pay-per-order plan beside them, and the console's
// plan fields behind it.

const { app, request, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

let seq = 0;
function plan(overrides = {}) {
  seq += 1;
  return db.Plan.create({
    key: `plan-${seq}`,
    name: `Plan ${seq}`,
    monthlyPriceAmount: 79900,
    yearlyPriceAmount: 799000,
    currency: 'EGP',
    trialDays: 14,
    softOrderQuota: 500,
    transactionFeeBp: 150,
    codFeeBp: 75,
    features: ['funnels', 'custom_domain', 'not_a_feature'],
    isActive: true,
    isPublic: true,
    ...overrides,
  });
}

const getPublic = () => request(app).get('/api/v1/plans/public');

describe('GET /plans/public', () => {
  it('answers an empty list when no plan is public, without signing in', async () => {
    await plan({ isPublic: false });
    const res = await getPublic();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ plans: [], payPerOrder: null });
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
  });

  it('lists only public, active plans, by display order', async () => {
    const second = await plan({ name: 'Growth', displayOrder: 2 });
    const first = await plan({ name: 'Starter', displayOrder: 1, monthlyPriceAmount: 29900 });
    await plan({ name: 'Hidden', isPublic: false });
    await plan({ name: 'Retired', isActive: false });

    const res = await getPublic();
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p) => p.id)).toEqual([first.id, second.id]);
  });

  it('serves prices in minor units and the limits, and nothing internal', async () => {
    const p = await plan({ maxStores: 3, maxFunnelsPerMonth: 10, trialDays: 7 });
    const [row] = (await getPublic()).body.plans;
    expect(row).toEqual({
      id: p.id,
      name: p.name,
      currency: 'EGP',
      monthlyPrice: 79900,
      yearlyPrice: 799000,
      trialDays: 7,
      maxStores: 3,
      maxFunnelsPerMonth: 10,
      softOrderQuota: 500,
      // Catalogue keys only.
      features: ['funnels', 'custom_domain'],
    });
    for (const internal of ['key', 'code', 'transactionFeeBp', 'codFeeBp', 'isPublic', 'isActive', 'displayOrder', 'createdAt']) {
      expect(row).not.toHaveProperty(internal);
    }
  });

  it('reports null limits as unlimited', async () => {
    await plan();
    const [row] = (await getPublic()).body.plans;
    expect(row.maxStores).toBeNull();
    expect(row.maxFunnelsPerMonth).toBeNull();
  });
});

describe('GET /plans/public — the pay-per-order plan', () => {
  const feePlan = (overrides = {}) =>
    plan({ name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, perOrderFeeAmount: 500, walletFreeOrders: 10, walletDebtLimitAmount: 2500, ...overrides });

  afterEach(() => {
    env.wallet.enabled = false;
    env.ordersLock.enabled = false;
  });

  it('sends it beside the list while WALLET_ENABLED is on, never in it', async () => {
    env.wallet.enabled = true;
    const monthly = await plan({ name: 'Starter' });
    const ppo = await feePlan();

    const res = await getPublic();
    expect(res.status).toBe(200);
    expect(res.body.plans.map((p) => p.id)).toEqual([monthly.id]);
    expect(res.body.payPerOrder).toEqual({
      id: ppo.id,
      name: 'Pay per order',
      currency: 'EGP',
      feePerOrder: 500,
      freeOrders: 10,
      feeChargedAt: 'placement',
    });
  });

  it('serves the free orders the console set, 0 included', async () => {
    env.wallet.enabled = true;
    const ppo = await feePlan({ walletFreeOrders: 25 });
    expect((await getPublic()).body.payPerOrder.freeOrders).toBe(25);

    await ppo.update({ walletFreeOrders: 0 });
    expect((await getPublic()).body.payPerOrder.freeOrders).toBe(0);
  });

  it('says the fee is taken at confirmation while ORDERS_LOCK_ENABLED is on', async () => {
    env.wallet.enabled = true;
    env.ordersLock.enabled = true;
    await feePlan();
    expect((await getPublic()).body.payPerOrder.feeChargedAt).toBe('confirmation');
  });

  it.each([
    ['inactive', { isActive: false }],
    ['hidden from sign-up', { isPublic: false }],
  ])('leaves it out when %s', async (_label, overrides) => {
    env.wallet.enabled = true;
    await feePlan(overrides);
    expect((await getPublic()).body.payPerOrder).toBeNull();
  });

  it('leaves it out while WALLET_ENABLED is off', async () => {
    await feePlan();
    const res = await getPublic();
    expect(res.body).toEqual({ plans: [], payPerOrder: null });
  });

  it('serves nothing internal of it', async () => {
    env.wallet.enabled = true;
    await feePlan();
    const row = (await getPublic()).body.payPerOrder;
    for (const internal of ['key', 'walletDebtLimitAmount', 'debtLimit', 'transactionFeeBp', 'codFeeBp', 'isPublic', 'isActive', 'displayOrder']) {
      expect(row).not.toHaveProperty(internal);
    }
  });
});

describe('the console plan editor', () => {
  const body = (overrides = {}) => ({
    name: 'Pro',
    code: 'pro',
    monthlyPrice: 49900,
    trialDays: 14,
    orderQuota: null,
    transactionFeeBp: 0,
    codFeeBp: 0,
    features: [],
    active: true,
    ...overrides,
  });

  it('creates a plan with limits and visibility, and audits it', async () => {
    const admin = await makePlatformUser('admin');
    const res = await request(app)
      .post('/api/v1/admin/plans')
      .set(admin.H)
      .send(body({ trialDays: 0, maxStores: 2, maxFunnelsPerMonth: 5, isPublic: true, displayOrder: 3 }));
    expect(res.status).toBe(201);
    expect(res.body.plan).toMatchObject({ trialDays: 0, maxStores: 2, maxFunnelsPerMonth: 5, isPublic: true, displayOrder: 3 });
    const log = await db.AuditLog.findOne({ where: { action: 'plan.create', entityId: res.body.plan.id } });
    expect(log.afterState).toMatchObject({ maxStores: 2, isPublic: true });
    expect((await getPublic()).body.plans.map((p) => p.id)).toEqual([res.body.plan.id]);
  });

  it('defaults a new plan to private and unlimited', async () => {
    const admin = await makePlatformUser('admin');
    const res = await request(app).post('/api/v1/admin/plans').set(admin.H).send(body());
    expect(res.body.plan).toMatchObject({ maxStores: null, maxFunnelsPerMonth: null, isPublic: false, displayOrder: 0 });
  });

  it('keeps the limits when a console from before them saves the plan', async () => {
    const admin = await makePlatformUser('admin');
    const p = await plan({ key: 'keep', maxStores: 4, maxFunnelsPerMonth: 6, isPublic: true, displayOrder: 2 });
    const res = await request(app)
      .patch(`/api/v1/admin/plans/${p.id}`)
      .set(admin.H)
      .send(body({ name: 'Renamed', code: 'keep' }));
    expect(res.status).toBe(200);
    expect(res.body.plan).toMatchObject({ name: 'Renamed', maxStores: 4, maxFunnelsPerMonth: 6, isPublic: true, displayOrder: 2 });
  });

  it('clears a limit with null and audits the before and after', async () => {
    const admin = await makePlatformUser('admin');
    const p = await plan({ key: 'clear', maxStores: 4 });
    const res = await request(app)
      .patch(`/api/v1/admin/plans/${p.id}`)
      .set(admin.H)
      .send(body({ code: 'clear', maxStores: null }));
    expect(res.status).toBe(200);
    expect(res.body.plan.maxStores).toBeNull();
    const log = await db.AuditLog.findOne({ where: { action: 'plan.update', entityId: p.id } });
    expect(log.beforeState.maxStores).toBe(4);
    expect(log.afterState.maxStores).toBeNull();
  });

  it.each([
    [{ trialDays: 91 }, 'trialDays'],
    [{ trialDays: -1 }, 'trialDays'],
    [{ maxStores: 0 }, 'maxStores'],
    [{ maxFunnelsPerMonth: -1 }, 'maxFunnelsPerMonth'],
    [{ displayOrder: -1 }, 'displayOrder'],
    [{ isPublic: 'yes' }, 'isPublic'],
  ])('refuses %j', async (patch, field) => {
    const admin = await makePlatformUser('admin');
    const res = await request(app).post('/api/v1/admin/plans').set(admin.H).send(body(patch));
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  it('refuses limits below their minimum at the database too', async () => {
    await expect(plan({ maxStores: 0 })).rejects.toThrow();
    await expect(plan({ maxFunnelsPerMonth: -1 })).rejects.toThrow();
    await expect(plan({ trialDays: -1 })).rejects.toThrow();
  });
});
