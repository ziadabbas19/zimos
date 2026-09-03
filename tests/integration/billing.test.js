'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const billingService = require('../../src/modules/billing/billingService');

// The global beforeEach (tests/helpers/setup.js) truncates every table first;
// re-seed the default plans after that so workspace creation picks a real plan.
beforeEach(async () => {
  await billingService.seedDefaultPlans();
});

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Billing Co');
  return {
    auth,
    workspace,
    wid: workspace.id,
    userId: auth.userId,
    H: { Authorization: `Bearer ${auth.accessToken}` },
  };
}

const subOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });

describe('subscription scaffolding (no gateway)', () => {
  it('a new workspace starts on a trialing subscription with a ~14-day trial end and no gateway id', async () => {
    const before = Date.now();
    const { wid } = await setup();

    const sub = await subOf(wid);
    expect(sub).not.toBeNull();
    expect(sub.status).toBe('trialing');
    expect(sub.externalSubscriptionId).toBeNull();
    expect(sub.externalProvider).toBeNull();
    expect(sub.planId).not.toBeNull(); // 'free' plan seeded in beforeEach

    const days = (new Date(sub.currentPeriodEnd).getTime() - before) / 86400000;
    expect(days).toBeGreaterThan(13.5);
    expect(days).toBeLessThan(14.5);
  });

  it('the webhook flips subscription status on mapped events (with the stubbed signature check)', async () => {
    const { wid } = await setup();

    const activated = await request(app)
      .post('/api/v1/billing/webhook')
      .send({ type: 'subscription.activated', data: { workspaceId: wid } });
    expect(activated.status).toBe(200);
    expect(activated.body.handled).toBe(true);
    expect((await subOf(wid)).status).toBe('active');

    await request(app).post('/api/v1/billing/webhook').send({ type: 'payment.failed', data: { workspaceId: wid } });
    expect((await subOf(wid)).status).toBe('past_due');

    await request(app).post('/api/v1/billing/webhook').send({ type: 'subscription.canceled', data: { workspaceId: wid } });
    expect((await subOf(wid)).status).toBe('cancelled');
  });

  it('the webhook is a safe no-op for an unmapped event type', async () => {
    const { wid } = await setup();
    const res = await request(app)
      .post('/api/v1/billing/webhook')
      .send({ type: 'invoice.paid', data: { workspaceId: wid } });
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);
  });

  it('blocks creating new pages/funnels once the subscription lapses, but keeps a live storefront serving buyers', async () => {
    const { wid, H } = await setup();

    // Publish a store while still trialing.
    const provisioned = await request(app)
      .post(`/api/v1/workspaces/${wid}/quickstart`)
      .set(H)
      .type('form')
      .send({ template: 'light', productName: 'Live Widget', price: '50.00', description: 'still selling' });
    expect(provisioned.status).toBe(200);

    // Lapse it.
    await request(app).post('/api/v1/billing/webhook').send({ type: 'subscription.canceled', data: { workspaceId: wid } });

    // Mutating actions are blocked with a clear error.
    const blockedSite = await request(app)
      .post(`/api/v1/workspaces/${wid}/websites`)
      .set(H)
      .send({ name: 'Another site' });
    expect(blockedSite.status).toBe(402);
    expect(blockedSite.body.error.code).toBe('SUBSCRIPTION_REQUIRED');

    const blockedFunnel = await request(app).post(`/api/v1/workspaces/${wid}/funnels`).set(H).send({ name: 'F' });
    expect(blockedFunnel.status).toBe(402);

    // The already-published storefront is untouched — never break a live campaign over billing.
    const shop = await request(app).get(`/shop/${wid}`);
    expect(shop.status).toBe(200);
    expect(shop.text).toContain('Live Widget');
  });

  it('the trial-expiry sweep flips a lapsed trial to past_due', async () => {
    const { wid } = await setup();
    await db.Subscription.update(
      { currentPeriodEnd: new Date(Date.now() - 86400000) },
      { where: { workspaceId: wid } }
    );

    const res = await billingService.expireStaleTrials();
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect((await subOf(wid)).status).toBe('past_due');
  });

  it('a platform admin can list all workspaces with plan/status; a normal user is refused', async () => {
    const { wid, H, userId } = await setup();

    const denied = await request(app).get('/api/v1/admin/workspaces').set(H);
    expect(denied.status).toBe(403);

    await db.User.update({ platformAdmin: true }, { where: { id: userId } });
    const ok = await request(app).get('/api/v1/admin/workspaces').set(H);
    expect(ok.status).toBe(200);

    const row = ok.body.workspaces.find((w) => w.workspaceId === wid);
    expect(row).toBeDefined();
    expect(row.workspaceName).toBe('Billing Co');
    expect(row.status).toBe('trialing');
    expect(row).toHaveProperty('orderCount');
  });

  it('renders the platform-admin dashboard as HTML', async () => {
    const { H, userId } = await setup();
    await db.User.update({ platformAdmin: true }, { where: { id: userId } });

    const res = await request(app).get('/api/v1/admin/dashboard').set(H);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toMatch(/Platform admin/);
    expect(res.text).toContain('Billing Co');
  });
});
