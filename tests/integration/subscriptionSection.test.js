'use strict';

// The merchant's Subscription section (billing/merchantPlansService) and the
// free trial, once per account (billing/goLiveService): the plan list with
// server prices, a referral code's preview, the charges page by page,
// changing plan while nothing is paid, and who may do any of it.

const { app, request, registerAndActivate, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const ORIGINAL_SIGNUP = { ...env.signup, paymentInstructions: { ...env.signup.paymentInstructions } };
afterEach(() => {
  Object.assign(env.signup, ORIGINAL_SIGNUP, { paymentInstructions: { ...ORIGINAL_SIGNUP.paymentInstructions } });
});

let seq = 0;
function plan(overrides = {}) {
  seq += 1;
  return db.Plan.create({
    key: `section-${seq}`,
    name: `Plan ${seq}`,
    monthlyPriceAmount: 30000,
    yearlyPriceAmount: 300000,
    currency: 'EGP',
    trialDays: 14,
    features: [],
    isActive: true,
    isPublic: true,
    maxStores: 2,
    maxFunnelsPerMonth: 5,
    ...overrides,
  });
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

/** A store made with drafts on (REQUIRE_SUBSCRIPTION_TO_GO_LIVE), on `onPlan`, by `owner` (a fresh one by default). */
async function draftStore({ onPlan, owner, name = 'Draft Store' } = {}) {
  env.signup.requireSubscription = true;
  const who = owner || (await registerAndActivate());
  const res = await request(app).post('/api/v1/workspaces').set(bearer(who.accessToken)).send({ name });
  if (res.status !== 201) throw new Error(`draftStore: ${res.status} ${JSON.stringify(res.body)}`);
  const ws = res.body.workspace;
  const p = onPlan || (await plan());
  await db.Subscription.update({ planId: p.id }, { where: { workspaceId: ws.id } });
  return { owner: who, H: bearer(who.accessToken), wid: ws.id, plan: p };
}

const subOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });
const base = (wid) => `/api/v1/workspaces/${wid}/billing`;

function charge(subscription, overrides = {}) {
  const now = new Date();
  return db.BillingInvoice.create({
    workspaceId: subscription.workspaceId,
    subscriptionId: subscription.id,
    grossAmount: 30000,
    discountAmount: 0,
    amount: 30000,
    currency: 'EGP',
    status: 'paid',
    periodStart: now,
    periodEnd: new Date(now.getTime() + 30 * 86400000),
    paidAt: now,
    paymentNote: 'internal note',
    ...overrides,
  });
}

describe('GET /billing/plans', () => {
  it('lists the plans on offer with server prices, limits and features, and the private current plan too', async () => {
    const privatePlan = await plan({ isPublic: false, name: 'Legacy' });
    const s = await draftStore({ onPlan: privatePlan });
    const offered = await plan({ name: 'Offered', monthlyPriceAmount: 50000, features: ['custom_domain'] });

    const res = await request(app).get(`${base(s.wid)}/plans`).set(s.H);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.plans.map((p) => [p.id, p]));
    expect(byId[privatePlan.id]).toMatchObject({ isCurrent: true, isPublic: false });
    expect(byId[offered.id]).toMatchObject({ isCurrent: false, isPublic: true, maxStores: 2, maxFunnelsPerMonth: 5 });
    expect(byId[offered.id].prices).toEqual({
      monthly: { gross: 50000, discount: 0, net: 50000 },
      yearly: { gross: 500000, discount: 0, net: 500000 }, // 10 × monthly
    });
    expect(res.body).toMatchObject({ trial: { available: true, used: false }, planChange: 'immediate', subscription: { draft: true } });
  });

  it("takes an attached referral code's discount off every price", async () => {
    const s = await draftStore();
    const agent = await registerAndActivate();
    const code = await db.ReferralCode.create({ agentId: agent.userId, code: 'SAVE10', discountType: 'percentage', discountValue: 1000 });
    await db.Subscription.update({ referralCodeId: code.id, referralCodeAttachedAt: new Date() }, { where: { workspaceId: s.wid } });

    const res = await request(app).get(`${base(s.wid)}/plans`).set(s.H);
    const mine = res.body.plans.find((p) => p.id === s.plan.id);
    expect(mine.prices.monthly).toEqual({ gross: 30000, discount: 3000, net: 27000 });
    expect(mine.prices.yearly).toEqual({ gross: 300000, discount: 30000, net: 270000 });
    // A first-kind code: no schedule, no one-time benefit, no end (the fields migration 725 added).
    expect(res.body.referralCode).toEqual({
      code: 'SAVE10',
      discountType: 'percentage',
      discountValue: 1000,
      discountCurrency: null,
      active: true,
      discountSchedule: null,
      grant: null,
      endsAt: null,
    });
    expect(JSON.stringify(res.body)).not.toContain(agent.userId); // never the agent
  });
});

describe('POST /billing/code-preview', () => {
  it("shows what a code would take off each plan without attaching it, and refuses one that can't be used", async () => {
    const s = await draftStore();
    const agent = await registerAndActivate();
    await db.ReferralCode.create({ agentId: agent.userId, code: 'MINUS50', discountType: 'fixed', discountValue: 5000, discountCurrency: 'EGP' });

    const res = await request(app).post(`${base(s.wid)}/code-preview`).set(s.H).send({ code: 'minus50' });
    expect(res.status).toBe(200);
    expect(res.body.code).toMatchObject({ code: 'MINUS50', discountType: 'fixed' });
    expect(res.body.plans.find((p) => p.planId === s.plan.id).prices.monthly).toEqual({ gross: 30000, discount: 5000, net: 25000 });
    expect((await subOf(s.wid)).referralCodeId).toBeNull();

    const bad = await request(app).post(`${base(s.wid)}/code-preview`).set(s.H).send({ code: 'NOPE99' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('REFERRAL_CODE_INVALID');
  });
});

describe('GET /billing/invoices', () => {
  it("pages through this store's charges only, newest first, without internal fields", async () => {
    const s = await draftStore();
    const other = await draftStore({ name: 'Other' });
    const sub = await subOf(s.wid);
    for (let i = 0; i < 3; i += 1) {
      await charge(sub, { createdAt: new Date(Date.now() - i * 60000) });
    }
    await charge(await subOf(other.wid));

    const first = await request(app).get(`${base(s.wid)}/invoices?page=1&pageSize=2`).set(s.H);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(first.body.invoices).toHaveLength(2);
    expect(first.body.invoices[0]).not.toHaveProperty('paymentNote');
    expect(new Date(first.body.invoices[0].createdAt) >= new Date(first.body.invoices[1].createdAt)).toBe(true);
    const second = await request(app).get(`${base(s.wid)}/invoices?page=2&pageSize=2`).set(s.H);
    expect(second.body.invoices).toHaveLength(1);
  });
});

describe('POST /billing/plan', () => {
  it('changes plan at once in a draft and in a trial (keeping its end), and audits it', async () => {
    const s = await draftStore();
    const next = await plan({ name: 'Next' });
    const res = await request(app).post(`${base(s.wid)}/plan`).set(s.H).send({ planId: next.id, billingCycle: 'yearly' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(await subOf(s.wid)).toMatchObject({ planId: next.id, billingCycle: 'yearly' });

    const end = new Date(Date.now() + 5 * 86400000);
    await db.Subscription.update({ status: 'trialing', trialEndsAt: end, currentPeriodEnd: end }, { where: { workspaceId: s.wid } });
    const third = await plan({ name: 'Third' });
    expect((await request(app).post(`${base(s.wid)}/plan`).set(s.H).send({ planId: third.id })).status).toBe(200);
    const after = await subOf(s.wid);
    expect(after.planId).toBe(third.id);
    expect(after.currentPeriodEnd.getTime()).toBe(end.getTime());

    const audits = await db.AuditLog.count({ where: { action: 'subscription.plan_change', workspaceId: s.wid } });
    expect(audits).toBe(2);
  });

  it('sends a paid subscription to support, and refuses a private plan or an open charge', async () => {
    const s = await draftStore();
    const privatePlan = await plan({ isPublic: false });
    const priv = await request(app).post(`${base(s.wid)}/plan`).set(s.H).send({ planId: privatePlan.id });
    expect(priv.status).toBe(422);
    expect(priv.body.error.code).toBe('PLAN_NOT_AVAILABLE');

    const next = await plan();
    await charge(await subOf(s.wid), { status: 'pending', paidAt: null });
    const open = await request(app).post(`${base(s.wid)}/plan`).set(s.H).send({ planId: next.id });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe('OPEN_CHARGE_EXISTS');

    await db.Subscription.update({ status: 'active', currentPeriodEnd: new Date(Date.now() + 20 * 86400000) }, { where: { workspaceId: s.wid } });
    const paid = await request(app).post(`${base(s.wid)}/plan`).set(s.H).send({ planId: next.id });
    expect(paid.status).toBe(409);
    expect(paid.body.error.code).toBe('PLAN_CHANGE_NEEDS_SUPPORT');
    expect((await subOf(s.wid)).planId).toBe(s.plan.id);
  });
});

describe('the free trial, once per account', () => {
  it("starts on another plan on offer for that plan's trial days, and never on a private one", async () => {
    const s = await draftStore();
    const privatePlan = await plan({ isPublic: false });
    const priv = await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H).send({ planId: privatePlan.id });
    expect(priv.status).toBe(422);

    const seven = await plan({ trialDays: 7 });
    const res = await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H).send({ planId: seven.id });
    expect(res.status).toBe(201);
    const sub = await subOf(s.wid);
    expect(sub).toMatchObject({ status: 'trialing', planId: seven.id });
    const days = (sub.currentPeriodEnd - sub.currentPeriodStart) / 86400000;
    expect(Math.round(days)).toBe(7);
  });

  it("is spent by any trial the account had, on any plan, and a second store can't start another", async () => {
    const s = await draftStore();
    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H).send({})).status).toBe(201);

    const second = await draftStore({ owner: s.owner, name: 'Second' });
    const res = await request(app).post(`/api/v1/workspaces/${second.wid}/start-trial`).set(s.H).send({ planId: (await plan()).id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'TRIAL_NOT_AVAILABLE', details: { reason: 'used' } });
    expect((await request(app).get(`${base(second.wid)}/plans`).set(s.H)).body.trial).toEqual({ available: false, used: true });
  });

  it('two stores of one account starting a trial at the same moment get one between them', async () => {
    const s = await draftStore();
    // One account can't open a second draft while the first is one, so the
    // first is briefly out of draft while the second is made (as with stores
    // left from before the limit).
    await db.Subscription.update({ status: 'trialing' }, { where: { workspaceId: s.wid } });
    const second = await draftStore({ owner: s.owner, name: 'Racer' });
    await db.Subscription.update({ status: 'draft' }, { where: { workspaceId: s.wid } });
    const other = await plan();
    // Each "has this account had a trial?" read takes a while, so both
    // requests are inside it together: only the per-account lock keeps the
    // second from reading "no" before the first has written its trial.
    const read = db.PlanTrial.findOne.bind(db.PlanTrial);
    const slow = jest.spyOn(db.PlanTrial, 'findOne').mockImplementation(async (...args) => {
      const row = await read(...args);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return row;
    });
    try {
      const results = await Promise.all([
        request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H).send({}),
        request(app).post(`/api/v1/workspaces/${second.wid}/start-trial`).set(s.H).send({ planId: other.id }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    } finally {
      slow.mockRestore();
    }
    expect(await db.PlanTrial.count({ where: { userId: s.owner.userId } })).toBe(1);
  });

  it('a row from before (a trial on another plan) already counts', async () => {
    const s = await draftStore();
    const earlier = await plan();
    await db.PlanTrial.create({ userId: s.owner.userId, planId: earlier.id, workspaceId: null, source: 'backfill', startedAt: new Date() });
    const res = await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(s.H).send({});
    expect(res.status).toBe(409);
  });
});

describe('who may use it', () => {
  it('only members with billing.manage of this store', async () => {
    const s = await draftStore();
    const outsider = await draftStore({ name: 'Outsider' });
    // Someone from another store: 404, the same as a store that doesn't exist.
    for (const res of await Promise.all([
      request(app).get(`${base(s.wid)}/plans`).set(outsider.H),
      request(app).get(`${base(s.wid)}/invoices`).set(outsider.H),
      request(app).post(`${base(s.wid)}/plan`).set(outsider.H).send({ planId: s.plan.id }),
      request(app).post(`${base(s.wid)}/code-preview`).set(outsider.H).send({ code: 'X' }),
      request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(outsider.H).send({}),
    ])) {
      expect(res.status).toBe(404);
    }
    expect((await subOf(s.wid)).status).toBe('draft');

    const operator = await addMemberWithRole(s.owner.accessToken, s.wid, 'order_operator');
    expect((await request(app).get(`${base(s.wid)}/plans`).set(bearer(operator.accessToken))).status).toBe(403);
    expect((await request(app).post(`/api/v1/workspaces/${s.wid}/start-trial`).set(bearer(operator.accessToken)).send({})).status).toBe(403);
  });
});
