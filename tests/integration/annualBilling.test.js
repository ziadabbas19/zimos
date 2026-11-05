'use strict';

// Annual billing (billing/planPricing): the annual price is always 10 × the
// monthly price, a subscription switches cycle from its next charge, and an
// annual charge is priced and dated for the full year — referral discount and
// commission included.

const { app, request, registerAndActivate, createWorkspace, addMemberWithRole, addPlatformKeys, approveReferralCode, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const billingService = require('../../src/modules/billing/billingService');
const charges = require('../../src/modules/billing/subscriptionChargeService');

beforeEach(async () => {
  await billingService.seedDefaultPlans();
});

const STARTER_MONTHLY = 29900;
const STARTER_YEARLY = 299000; // 10 × monthly

async function setup(referralCode) {
  const owner = await registerAndActivate();
  const res = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'Annual Store', referralCode });
  const wid = res.body.workspace.id;
  const starter = await db.Plan.findOne({ where: { key: 'starter' } });
  await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: wid } });
  return { owner, wid, H: { Authorization: `Bearer ${owner.accessToken}` } };
}

const setCycle = (wid, H, billingCycle) =>
  request(app).patch(`/api/v1/workspaces/${wid}/billing`).set(H).send({ billingCycle });

describe('annual plan prices', () => {
  it('are always 10 × the monthly price, whatever yearly price is sent', async () => {
    const admin = await makePlatformUser('admin');
    const starter = await db.Plan.findOne({ where: { key: 'starter' } });
    expect(Number(starter.yearlyPriceAmount)).toBe(STARTER_YEARLY);

    const created = await request(app).post('/api/v1/admin/plans').set(admin.H).send({
      name: 'Pro',
      code: 'pro',
      monthlyPrice: 50000,
      yearlyPrice: 1,
      currency: 'USD',
      trialDays: 14,
      transactionFeeBp: 0,
      codFeeBp: 0,
      features: [],
      active: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.plan).toMatchObject({ monthlyPrice: 50000, yearlyPrice: 500000 });

    // A monthly price change moves the annual one with it; no yearlyPrice needed.
    const updated = await request(app).patch(`/api/v1/admin/plans/${created.body.plan.id}`).set(admin.H).send({
      name: 'Pro',
      code: 'pro',
      monthlyPrice: 60000,
      currency: 'USD',
      trialDays: 14,
      transactionFeeBp: 0,
      codFeeBp: 0,
      features: [],
      active: true,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.plan.yearlyPrice).toBe(600000);
    expect(Number((await db.Plan.findByPk(created.body.plan.id)).yearlyPriceAmount)).toBe(600000);
  });
});

describe('choosing annual billing', () => {
  it('lets the merchant switch cycle for the next charge, audited in the workspace', async () => {
    const { owner, wid, H } = await setup();
    const res = await setCycle(wid, H, 'yearly');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      changed: true,
      billing: {
        subscription: { billingCycle: 'yearly', plan: { monthlyPrice: STARTER_MONTHLY, yearlyPrice: STARTER_YEARLY } },
        nextCharge: { grossAmount: STARTER_YEARLY, amount: STARTER_YEARLY },
      },
    });
    const [audit] = await db.AuditLog.findAll({ where: { action: 'subscription.billing_cycle_change' } });
    expect(audit).toMatchObject({ workspaceId: wid, beforeState: { billingCycle: 'monthly' }, afterState: { billingCycle: 'yearly' } });

    expect((await setCycle(wid, H, 'yearly')).body.changed).toBe(false);
    expect((await setCycle(wid, H, 'weekly')).status).toBe(422);
    // billing.manage: an order operator cannot.
    const operator = await addMemberWithRole(owner.accessToken, wid, 'order_operator');
    expect((await setCycle(wid, { Authorization: `Bearer ${operator.accessToken}` }, 'monthly')).status).toBe(403);
  });

  it('prices and dates an annual charge for the full year, with the referral discount and commission on it', async () => {
    const admin = await makePlatformUser('admin');
    await addPlatformKeys(admin.userId, ['agents.create']);
    const person = await registerAndActivate();
    const made = await request(app)
      .post('/api/v1/admin/agents')
      .set(admin.H)
      .send({ email: person.email, firstCode: { code: 'YEAR10', discountType: 'percentage', discountValue: 1000 } })
      .expect(201);
    await approveReferralCode(made.body.code.id);
    const { wid, H } = await setup('YEAR10');
    await setCycle(wid, H, 'yearly').expect(200);

    const { invoice } = await charges.createCharge(wid);
    expect(Number(invoice.grossAmount)).toBe(STARTER_YEARLY);
    // 10% of 299000.
    expect(Number(invoice.discountAmount)).toBe(29900);
    expect(Number(invoice.amount)).toBe(269100);
    const start = new Date(invoice.periodStart);
    const end = new Date(invoice.periodEnd);
    expect(end.getUTCFullYear() - start.getUTCFullYear()).toBe(1);
    expect(end.getUTCMonth()).toBe(start.getUTCMonth());

    await request(app).post(`/api/v1/admin/charges/${invoice.id}/record-payment`).set(admin.H).send({ amountReceived: 269100 }).expect(200);
    const sub = await db.Subscription.findOne({ where: { workspaceId: wid } });
    expect(new Date(sub.currentPeriodEnd).getTime()).toBe(end.getTime());
    const [row] = await db.AgentCommission.findAll({ where: { workspaceId: wid } });
    // 30% of the annual amount paid.
    expect(Number(row.amountPaid)).toBe(269100);
    expect(Number(row.suggestedCommission)).toBe(80730);
  });

  it('refuses to switch while a charge is open; an admin can switch from the console', async () => {
    const { wid, H } = await setup();
    const admin = await makePlatformUser('admin');
    await request(app).post(`/api/v1/admin/workspaces/${wid}/charges`).set(admin.H).expect(201);

    const blocked = await setCycle(wid, H, 'yearly');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('OPEN_CHARGE_EXISTS');

    const charge = (await request(app).get(`/api/v1/admin/workspaces/${wid}/charges`).set(admin.H)).body.charges[0];
    await request(app).post(`/api/v1/admin/charges/${charge.id}/record-payment`).set(admin.H).send({ amountReceived: STARTER_MONTHLY });

    const agent = await makePlatformUser('agent');
    expect((await request(app).patch(`/api/v1/admin/workspaces/${wid}/subscription`).set(agent.H).send({ billingCycle: 'yearly' })).status).toBe(403);
    const res = await request(app).patch(`/api/v1/admin/workspaces/${wid}/subscription`).set(admin.H).send({ billingCycle: 'yearly' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      changed: true,
      subscription: { billingCycle: 'yearly', planPrices: { monthly: STARTER_MONTHLY, yearly: STARTER_YEARLY, currency: 'USD' } },
      nextCharge: { grossAmount: STARTER_YEARLY },
    });
    const audit = await db.AuditLog.findOne({ where: { action: 'subscription.billing_cycle_change', actorUserId: admin.userId } });
    expect(audit).toMatchObject({ workspaceId: null, metadata: { workspaceId: wid } });
  });
});
