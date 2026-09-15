'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const billingService = require('../../src/modules/billing/billingService');

// The global beforeEach truncates every table; re-seed plans so workspace
// creation has something to put a trial on.
beforeEach(async () => {
  await billingService.seedDefaultPlans();
});

/** A platform admin plus a workspace they can target. */
async function setupAdmin() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Admin Co');
  await db.User.update({ platformAdmin: true }, { where: { id: auth.userId } });
  return {
    wid: workspace.id,
    userId: auth.userId,
    H: { Authorization: `Bearer ${auth.accessToken}` },
  };
}

/** A normal (non-admin) user, for the authorization checks. */
async function setupPlain() {
  const auth = await registerAndActivate();
  await createWorkspace(auth.accessToken, 'Plain Co');
  return { H: { Authorization: `Bearer ${auth.accessToken}` } };
}

const PLAN_BODY = {
  name: 'Scale',
  code: 'scale',
  monthlyPrice: 149900,
  yearlyPrice: 1499900,
  trialDays: 30,
  orderQuota: 10000,
  transactionFeeBp: 250,
  codFeeBp: 400,
  features: ['custom_domain', 'funnels'],
  active: true,
};

describe('platform admin — every list endpoint returns a named array', () => {
  // The bug this suite exists for: a page crashed on `list.map` because the
  // list wasn't an array. Assert the container shape on every collection.
  it.each([
    ['/api/v1/admin/plans', 'plans'],
    ['/api/v1/admin/subscriptions', 'subscriptions'],
    ['/api/v1/admin/feature-flags', 'featureFlags'],
    ['/api/v1/admin/announcements', 'announcements'],
    ['/api/v1/admin/workspaces', 'workspaces'],
  ])('GET %s returns { %s: [...] }', async (path, key) => {
    const { H } = await setupAdmin();
    const res = await request(app).get(path).set(H);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body[key])).toBe(true);
  });

  it.each([
    '/api/v1/admin/plans',
    '/api/v1/admin/subscriptions',
    '/api/v1/admin/feature-flags',
    '/api/v1/admin/announcements',
  ])('GET %s refuses a non-admin', async (path) => {
    const { H } = await setupPlain();
    expect((await request(app).get(path).set(H)).status).toBe(403);
  });

  it.each([
    '/api/v1/admin/plans',
    '/api/v1/admin/subscriptions',
    '/api/v1/admin/feature-flags',
    '/api/v1/admin/announcements',
  ])('GET %s refuses an anonymous caller', async (path) => {
    expect((await request(app).get(path)).status).toBe(401);
  });
});

describe('platform admin — plans', () => {
  it('lists the seeded plans with prices as numbers and features as an array', async () => {
    const { H } = await setupAdmin();
    const res = await request(app).get('/api/v1/admin/plans').set(H);

    expect(res.status).toBe(200);
    const free = res.body.plans.find((p) => p.code === 'free');
    expect(free).toBeDefined();
    // BIGINT comes off pg as a string; the serializer has to cast it.
    expect(typeof free.monthlyPrice).toBe('number');
    // The seed writes `features` as {}, the editor writes an array — readers
    // always get an array.
    expect(Array.isArray(free.features)).toBe(true);
    expect(free.active).toBe(true);
  });

  it('creates, updates and deletes a plan', async () => {
    const { H } = await setupAdmin();

    const created = await request(app).post('/api/v1/admin/plans').set(H).send(PLAN_BODY);
    expect(created.status).toBe(201);
    expect(created.body.plan.code).toBe('scale');
    expect(created.body.plan.transactionFeeBp).toBe(250);
    expect(created.body.plan.features).toEqual(['custom_domain', 'funnels']);
    const planId = created.body.plan.id;

    const updated = await request(app)
      .patch(`/api/v1/admin/plans/${planId}`)
      .set(H)
      .send({ ...PLAN_BODY, name: 'Scale Plus', active: false });
    expect(updated.status).toBe(200);
    expect(updated.body.plan.name).toBe('Scale Plus');
    expect(updated.body.plan.active).toBe(false);

    expect((await request(app).delete(`/api/v1/admin/plans/${planId}`).set(H)).status).toBe(200);
    expect(await db.Plan.findByPk(planId)).toBeNull();
  });

  it('refuses a duplicate plan code', async () => {
    const { H } = await setupAdmin();
    await request(app).post('/api/v1/admin/plans').set(H).send(PLAN_BODY);

    const dupe = await request(app).post('/api/v1/admin/plans').set(H).send(PLAN_BODY);
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('PLAN_CODE_TAKEN');
  });

  it('refuses to delete a plan that still has subscribers', async () => {
    const { H } = await setupAdmin();
    // The workspace created in setup is trialing on the cheapest plan.
    const inUse = await db.Plan.findOne({ where: { key: 'free' } });

    const res = await request(app).delete(`/api/v1/admin/plans/${inUse.id}`).set(H);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_IN_USE');
  });

  it('rejects a malformed plan code', async () => {
    const { H } = await setupAdmin();
    const res = await request(app)
      .post('/api/v1/admin/plans')
      .set(H)
      .send({ ...PLAN_BODY, code: 'Not A Code' });
    expect(res.status).toBe(422);
  });
});

describe('platform admin — subscriptions', () => {
  it('lists each subscription joined to its workspace and plan', async () => {
    const { H, wid } = await setupAdmin();
    const res = await request(app).get('/api/v1/admin/subscriptions').set(H);

    expect(res.status).toBe(200);
    const row = res.body.subscriptions.find((s) => s.workspaceId === wid);
    expect(row).toBeDefined();
    expect(row.workspaceName).toBe('Admin Co');
    expect(row.planName).toBeTruthy();
    expect(row.status).toBe('trialing');
    // A trialing subscription isn't paying yet.
    expect(row.mrr).toBe(0);
  });

  it('counts an active subscription toward MRR, normalising a yearly cycle', async () => {
    const { H, wid } = await setupAdmin();
    const plan = await db.Plan.findOne({ where: { key: 'starter' } });
    await db.Subscription.update(
      { status: 'active', planId: plan.id, billingCycle: 'yearly' },
      { where: { workspaceId: wid } }
    );

    const res = await request(app).get('/api/v1/admin/subscriptions').set(H);
    const row = res.body.subscriptions.find((s) => s.workspaceId === wid);
    expect(row.mrr).toBe(Math.round(Number(plan.yearlyPriceAmount) / 12));
  });

  it('filters by status', async () => {
    const { H, wid } = await setupAdmin();
    await db.Subscription.update({ status: 'past_due' }, { where: { workspaceId: wid } });

    const res = await request(app).get('/api/v1/admin/subscriptions?status=past_due').set(H);
    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);

    const none = await request(app).get('/api/v1/admin/subscriptions?status=cancelled').set(H);
    expect(none.body.subscriptions).toEqual([]);
  });
});

describe('platform admin — feature flags', () => {
  it('creates, updates and deletes a flag', async () => {
    const { H, wid } = await setupAdmin();

    const created = await request(app)
      .post('/api/v1/admin/feature-flags')
      .set(H)
      .send({ key: 'checkout.one_page_v2', description: 'New checkout', enabled: true, rollout: 25 });
    expect(created.status).toBe(201);
    expect(created.body.featureFlag.key).toBe('checkout.one_page_v2');
    expect(created.body.featureFlag.targetWorkspaceIds).toEqual([]);
    const flagId = created.body.featureFlag.id;

    const updated = await request(app)
      .patch(`/api/v1/admin/feature-flags/${flagId}`)
      .set(H)
      .send({
        key: 'checkout.one_page_v2',
        description: 'New checkout',
        enabled: true,
        rollout: 100,
        targetWorkspaceIds: [wid],
      });
    expect(updated.status).toBe(200);
    expect(updated.body.featureFlag.rollout).toBe(100);
    expect(updated.body.featureFlag.targetWorkspaceIds).toEqual([wid]);

    expect((await request(app).delete(`/api/v1/admin/feature-flags/${flagId}`).set(H)).status).toBe(200);
    expect(await db.FeatureFlag.findByPk(flagId)).toBeNull();
  });

  it('rejects a malformed key and an out-of-range rollout', async () => {
    const { H } = await setupAdmin();
    const badKey = await request(app).post('/api/v1/admin/feature-flags').set(H).send({ key: 'Bad Key!' });
    expect(badKey.status).toBe(422);

    const badRollout = await request(app)
      .post('/api/v1/admin/feature-flags')
      .set(H)
      .send({ key: 'ok.key', rollout: 140 });
    expect(badRollout.status).toBe(422);
  });

  it('refuses a duplicate key', async () => {
    const { H } = await setupAdmin();
    await request(app).post('/api/v1/admin/feature-flags').set(H).send({ key: 'dupe.flag' });

    const dupe = await request(app).post('/api/v1/admin/feature-flags').set(H).send({ key: 'dupe.flag' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('FLAG_KEY_TAKEN');
  });
});

describe('platform admin — announcements', () => {
  const base = { title: 'Maintenance', body: 'Back at 02:00.', severity: 'warning' };

  it('creates an all-audience announcement and records the author', async () => {
    const { H } = await setupAdmin();
    const res = await request(app)
      .post('/api/v1/admin/announcements')
      .set(H)
      .send({ ...base, audience: 'all' });

    expect(res.status).toBe(201);
    expect(res.body.announcement.audience).toBe('all');
    expect(res.body.announcement.planId).toBeNull();
    expect(res.body.announcement.workspaceId).toBeNull();
    expect(res.body.announcement.createdBy).toBe('Test User');
    // Defaulted server-side rather than required from the client.
    expect(res.body.announcement.startsAt).toBeTruthy();
    expect(res.body.announcement.dismissible).toBe(true);
  });

  it('resolves a workspace-targeted announcement to its workspace name', async () => {
    const { H, wid } = await setupAdmin();
    const res = await request(app)
      .post('/api/v1/admin/announcements')
      .set(H)
      .send({ ...base, audience: 'workspace', workspaceId: wid });

    expect(res.status).toBe(201);
    expect(res.body.announcement.workspaceId).toBe(wid);
    expect(res.body.announcement.workspaceName).toBe('Admin Co');
  });

  it('requires the target that the audience implies', async () => {
    const { H } = await setupAdmin();
    const noWorkspace = await request(app)
      .post('/api/v1/admin/announcements')
      .set(H)
      .send({ ...base, audience: 'workspace' });
    expect(noWorkspace.status).toBe(422);

    const noPlan = await request(app)
      .post('/api/v1/admin/announcements')
      .set(H)
      .send({ ...base, audience: 'plan' });
    expect(noPlan.status).toBe(422);
  });

  it('rejects an end time that is not after the start time', async () => {
    const { H } = await setupAdmin();
    const res = await request(app)
      .post('/api/v1/admin/announcements')
      .set(H)
      .send({
        ...base,
        audience: 'all',
        startsAt: '2026-01-02T00:00:00.000Z',
        endsAt: '2026-01-01T00:00:00.000Z',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_WINDOW');
  });

  it('updates and deletes an announcement', async () => {
    const { H, wid } = await setupAdmin();
    const created = await request(app)
      .post('/api/v1/admin/announcements')
      .set(H)
      .send({ ...base, audience: 'workspace', workspaceId: wid });
    const id = created.body.announcement.id;

    // Widening the audience has to clear the now-meaningless target.
    const updated = await request(app)
      .patch(`/api/v1/admin/announcements/${id}`)
      .set(H)
      .send({ ...base, title: 'All clear', audience: 'all' });
    expect(updated.status).toBe(200);
    expect(updated.body.announcement.title).toBe('All clear');
    expect(updated.body.announcement.workspaceId).toBeNull();

    expect((await request(app).delete(`/api/v1/admin/announcements/${id}`).set(H)).status).toBe(200);
    expect(await db.Announcement.findByPk(id)).toBeNull();
  });

  it('404s on an unknown announcement', async () => {
    const { H } = await setupAdmin();
    const missing = '00000000-0000-4000-8000-000000000000';
    const res = await request(app)
      .patch(`/api/v1/admin/announcements/${missing}`)
      .set(H)
      .send({ ...base, audience: 'all' });
    expect(res.status).toBe(404);
  });
});
