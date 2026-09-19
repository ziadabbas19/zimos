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
    ['/api/v1/admin/audit-log', 'auditLog'],
    ['/api/v1/admin/system/services', 'services'],
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
    '/api/v1/admin/audit-log',
    '/api/v1/admin/system/services',
    '/api/v1/admin/metrics/overview',
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

describe('platform admin — MRR never adds two currencies together', () => {
  /** An admin plus their access token, so extra workspaces can be created. */
  async function setupAdminWithToken() {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Admin Co');
    await db.User.update({ platformAdmin: true }, { where: { id: auth.userId } });
    return { auth, wid: workspace.id, H: { Authorization: `Bearer ${auth.accessToken}` } };
  }

  function makePlan(key, currency, monthly) {
    return db.Plan.create({
      key,
      name: key,
      monthlyPriceAmount: monthly,
      yearlyPriceAmount: monthly * 12,
      currency,
      trialDays: 0,
    });
  }

  /** Puts `workspaceId`'s subscription onto `plan`, actively paying. */
  function startPaying(workspaceId, plan) {
    return db.Subscription.update(
      { status: 'active', planId: plan.id, billingCycle: 'monthly' },
      { where: { workspaceId } }
    );
  }

  it('totals a single-currency book and names the currency', async () => {
    const { H, wid } = await setupAdminWithToken();
    const usd = await makePlan('usd-plan', 'USD', 29900);
    await startPaying(wid, usd);

    const res = await request(app).get('/api/v1/admin/subscriptions').set(H);
    expect(res.status).toBe(200);
    expect(res.body.mrr).toBe(29900);
    expect(res.body.mrrCurrency).toBe('USD');
    expect(res.body.mrrByCurrency).toEqual({ USD: 29900 });

    // The row carries its own currency too, so a client that sums the column
    // itself can run the same check.
    const row = res.body.subscriptions.find((r) => r.workspaceId === wid);
    expect(row.mrr).toBe(29900);
    expect(row.mrrCurrency).toBe('USD');
  });

  it('refuses to produce one number when the book spans currencies', async () => {
    const { auth, H, wid } = await setupAdminWithToken();
    const usd = await makePlan('usd-plan', 'USD', 29900);
    const egp = await makePlan('egp-plan', 'EGP', 500000);
    await startPaying(wid, usd);

    const second = await createWorkspace(auth.accessToken, 'Cairo Co');
    await startPaying(second.id, egp);

    const res = await request(app).get('/api/v1/admin/subscriptions').set(H);
    expect(res.status).toBe(200);
    // There is no FX layer, so USD + EGP has no correct single value. null is
    // the answer; 529900 would be a fabricated one.
    expect(res.body.mrr).toBeNull();
    expect(res.body.mrrCurrency).toBeNull();
    // ...but the breakdown is still real and still useful.
    expect(res.body.mrrByCurrency).toEqual({ USD: 29900, EGP: 500000 });
  });

  it('reports zero — not null — when nobody is paying', async () => {
    const { H } = await setupAdminWithToken();
    // The workspace is on a trial, so it contributes nothing.
    const res = await request(app).get('/api/v1/admin/subscriptions').set(H);

    // 0 and null mean different things: "no paying subscriptions" is a fact,
    // "cannot be expressed as one number" is not. They must not collapse.
    expect(res.body.mrr).toBe(0);
    expect(res.body.mrrCurrency).toBeNull();
    expect(res.body.mrrByCurrency).toEqual({});
  });

  it('gives a non-contributing row a null currency so it cannot skew the check', async () => {
    const { auth, H, wid } = await setupAdminWithToken();
    const usd = await makePlan('usd-plan', 'USD', 29900);
    const egp = await makePlan('egp-plan', 'EGP', 500000);
    await startPaying(wid, usd);

    // A cancelled EGP subscription earns nothing. If it still advertised EGP,
    // it would flip the whole book to "mixed" and null out a total that is
    // genuinely single-currency.
    const second = await createWorkspace(auth.accessToken, 'Cancelled Co');
    await db.Subscription.update(
      { status: 'cancelled', planId: egp.id },
      { where: { workspaceId: second.id } }
    );

    const res = await request(app).get('/api/v1/admin/subscriptions').set(H);
    const dead = res.body.subscriptions.find((r) => r.workspaceId === second.id);
    expect(dead.mrr).toBe(0);
    expect(dead.mrrCurrency).toBeNull();

    expect(res.body.mrr).toBe(29900);
    expect(res.body.mrrCurrency).toBe('USD');
  });
});

describe('platform admin — audit log', () => {
  /** Writes one audit entry directly; `recordAudit` is exercised by its callers. */
  function entry(overrides = {}) {
    return db.AuditLog.create({
      action: 'product.update',
      entityType: 'Product',
      ...overrides,
    });
  }

  it('returns newest first, with the actor and workspace resolved', async () => {
    const { H, wid, userId } = await setupAdmin();
    const product = await db.Product.create({
      workspaceId: wid,
      name: 'Blue Hoodie',
      slug: 'blue-hoodie',
      productCode: 'PRD-0001',
    });

    await entry({
      workspaceId: wid,
      actorUserId: userId,
      entityId: product.id,
      ipAddress: '203.0.113.9',
      userAgent: 'jest',
      beforeState: { name: 'Old' },
      afterState: { name: 'Blue Hoodie' },
    });

    const res = await request(app).get('/api/v1/admin/audit-log').set(H);
    expect(res.status).toBe(200);

    const row = res.body.auditLog.find((e) => e.entityId === product.id);
    expect(row).toBeDefined();
    expect(row.action).toBe('product.update');
    expect(row.entityType).toBe('Product');
    // Resolved from the referenced row, not stored on the entry.
    expect(row.entityLabel).toBe('Blue Hoodie');
    expect(row.workspaceId).toBe(wid);
    expect(row.workspaceName).toBe('Admin Co');
    expect(row.actorUserId).toBe(userId);
    expect(row.actorEmail).toEqual(expect.stringContaining('@'));
    expect(row.ip).toBe('203.0.113.9');
    expect(row.userAgent).toBe('jest');
    expect(row.before).toEqual({ name: 'Old' });
    expect(row.after).toEqual({ name: 'Blue Hoodie' });

    // register/login/workspace-create already wrote entries; the newest of
    // everything in the table must come first.
    const dates = res.body.auditLog.map((e) => new Date(e.createdAt).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  it('nulls absent references instead of inventing placeholders', async () => {
    const { H } = await setupAdmin();
    // No workspace, no actor, and an entity id that points at nothing.
    await entry({ entityId: '00000000-0000-4000-8000-000000000000' });

    const res = await request(app).get('/api/v1/admin/audit-log').set(H);
    const row = res.body.auditLog.find((e) => e.entityId === '00000000-0000-4000-8000-000000000000');

    expect(row.actorUserId).toBeNull();
    expect(row.actorName).toBeNull();
    expect(row.actorEmail).toBeNull();
    expect(row.workspaceId).toBeNull();
    expect(row.workspaceName).toBeNull();
    // The product row is gone (or never existed) — absence, not "Unknown".
    expect(row.entityLabel).toBeNull();
    expect(row.ip).toBeNull();
    expect(row.userAgent).toBeNull();
    expect(row.before).toBeNull();
    expect(row.after).toBeNull();
  });

  it('survives an entity_id that is not a UUID', async () => {
    // entity_id is a STRING(100); every model it points at has a UUID key.
    // Feeding a non-UUID into the label lookup would make Postgres reject the
    // whole query ("invalid input syntax for type uuid") and 500 the page.
    const { H } = await setupAdmin();
    await entry({ entityType: 'Product', entityId: 'legacy-sku-42' });

    const res = await request(app).get('/api/v1/admin/audit-log').set(H);
    expect(res.status).toBe(200);
    const row = res.body.auditLog.find((e) => e.entityId === 'legacy-sku-42');
    expect(row.entityLabel).toBeNull();
  });

  it('windows with limit/offset without repeating or dropping an entry', async () => {
    const { H, wid } = await setupAdmin();
    await db.AuditLog.destroy({ where: {} });
    // All written in one go, so they share a created_at and only the id
    // tiebreak keeps the order stable across the two requests.
    for (let i = 0; i < 10; i += 1) {
      await entry({ workspaceId: wid, entityId: `item-${i}` });
    }

    const p1 = await request(app).get('/api/v1/admin/audit-log?limit=4').set(H);
    const p2 = await request(app).get('/api/v1/admin/audit-log?limit=4&offset=4').set(H);

    // `total` counts the whole filtered set, not the returned window — the
    // admin UI uses it instead of guessing from rows.length.
    expect(p1.body.total).toBe(10);
    expect(p1.body.limit).toBe(4);
    expect(p1.body.offset).toBe(0);
    expect(p2.body.offset).toBe(4);
    expect(p1.body.auditLog).toHaveLength(4);
    expect(p2.body.auditLog).toHaveLength(4);

    const ids = [...p1.body.auditLog, ...p2.body.auditLog].map((e) => e.id);
    expect(new Set(ids).size).toBe(8);
  });

  it('honours the from/to window server-side', async () => {
    const { H, wid } = await setupAdmin();
    await db.AuditLog.destroy({ where: {} });
    const old = await entry({ workspaceId: wid, entityId: 'ancient' });
    await db.AuditLog.update(
      { createdAt: new Date('2020-01-01T00:00:00Z') },
      { where: { id: old.id }, silent: true }
    );
    await entry({ workspaceId: wid, entityId: 'recent' });

    const res = await request(app).get('/api/v1/admin/audit-log?from=2021-01-01T00:00:00.000Z').set(H);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.auditLog[0].entityId).toBe('recent');
  });

  it('filters by action, entityType and workspace', async () => {
    const { H, wid } = await setupAdmin();
    await db.AuditLog.destroy({ where: {} });
    await entry({ workspaceId: wid, action: 'product.delete', entityType: 'Product' });
    await entry({ workspaceId: wid, action: 'order.refund', entityType: 'Order' });
    await entry({ action: 'product.delete', entityType: 'Product' });

    const byAction = await request(app).get('/api/v1/admin/audit-log?action=product.delete').set(H);
    expect(byAction.body.total).toBe(2);

    const byType = await request(app).get('/api/v1/admin/audit-log?entityType=Order').set(H);
    expect(byType.body.total).toBe(1);

    const byWorkspace = await request(app).get(`/api/v1/admin/audit-log?workspaceId=${wid}`).set(H);
    expect(byWorkspace.body.total).toBe(2);
  });

  it('rejects a limit above the cap but accepts the window size the UI sends', async () => {
    const { H } = await setupAdmin();
    expect((await request(app).get('/api/v1/admin/audit-log?limit=5000').set(H)).status).toBe(422);
    // 200 is exactly what the admin UI sends — it must not be a 422.
    expect((await request(app).get('/api/v1/admin/audit-log?limit=200').set(H)).status).toBe(200);
  });
});

describe('platform admin — system services', () => {
  const systemServices = require('../../src/modules/platformAdmin/systemServicesService');
  const env = require('../../src/config/env');

  const ORIGINAL = {
    email: env.notifications.emailProvider,
    sms: env.notifications.smsProvider,
  };

  beforeEach(() => {
    // Start from a cold cache rather than a neighbour's reading.
    systemServices._resetCache();
    // Pin the providers rather than inheriting them from whatever .env the
    // machine happens to have: with EMAIL_PROVIDER=brevo set locally these
    // probes would fire real requests at Brevo and Twilio from the suite.
    env.notifications.emailProvider = 'console';
    env.notifications.smsProvider = 'console';
  });

  afterAll(() => {
    env.notifications.emailProvider = ORIGINAL.email;
    env.notifications.smsProvider = ORIGINAL.sms;
  });

  const STATUSES = ['operational', 'degraded', 'down', 'not_configured'];

  it('returns a tile per service, each with a status from the shared vocabulary', async () => {
    const { H } = await setupAdmin();
    const res = await request(app).get('/api/v1/admin/system/services').set(H);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.services)).toBe(true);
    expect(res.body.services.map((s) => s.key).sort()).toEqual(
      ['email', 'payments', 'postgres', 'sms', 'storage'].sort()
    );

    for (const tile of res.body.services) {
      // The console maps these to colours through a lookup with a neutral
      // fallback, so an unrecognised spelling renders grey and silent.
      expect(STATUSES).toContain(tile.status);
      // Never `unknown` — that value belongs to the browser's own fallback.
      expect(tile.status).not.toBe('unknown');
      expect(typeof tile.name).toBe('string');
      expect(tile.checkedAt).toEqual(expect.any(String));
      // v1 has no history table; these are null, not a fabricated 100%.
      expect(tile.uptime30d).toBeNull();
      expect(tile.lastIncidentAt).toBeNull();
      expect(tile.lastIncidentSummary).toBeNull();
    }
  });

  it('reports the database as operational, since the request itself proves it', async () => {
    const { H } = await setupAdmin();
    const res = await request(app).get('/api/v1/admin/system/services').set(H);

    const pg = res.body.services.find((s) => s.key === 'postgres');
    expect(pg.status).toBe('operational');
    expect(typeof pg.latencyMs).toBe('number');
    expect(pg.detail).toEqual(expect.any(String));
  });

  it('reports an absent payment gateway as not_configured, never operational', async () => {
    const { H } = await setupAdmin();
    const res = await request(app).get('/api/v1/admin/system/services').set(H);

    // `mock` and `cod` run in-process and reach nothing. A green tile here
    // would assert a payment gateway that does not exist.
    const payments = res.body.services.find((s) => s.key === 'payments');
    expect(payments.status).toBe('not_configured');
    expect(payments.detail).toEqual(expect.stringContaining('in-process'));
    expect(payments.latencyMs).toBeNull();
  });

  it('marks an unconfigured integration not_configured rather than down', async () => {
    const { H } = await setupAdmin();
    const res = await request(app).get('/api/v1/admin/system/services').set(H);

    // EMAIL_PROVIDER/SMS_PROVIDER default to `console` — deliberately off, so
    // neutral, not an error, and no network request was made.
    for (const key of ['email', 'sms']) {
      const tile = res.body.services.find((s) => s.key === key);
      expect(tile.status).toBe('not_configured');
      expect(tile.latencyMs).toBeNull();
    }
  });

  it('serves a cached reading from the GET but keeps checkedAt at probe time', async () => {
    const { H } = await setupAdmin();
    const first = await request(app).get('/api/v1/admin/system/services').set(H);
    const second = await request(app).get('/api/v1/admin/system/services').set(H);

    expect(first.body.cached).toBe(false);
    expect(second.body.cached).toBe(true);
    // The whole point: a cache hit must NOT restamp checkedAt to serve time,
    // or the console shows "checked just now" for a stale reading.
    const firstPg = first.body.services.find((s) => s.key === 'postgres');
    const secondPg = second.body.services.find((s) => s.key === 'postgres');
    expect(secondPg.checkedAt).toBe(firstPg.checkedAt);
  });

  it('POST /check bypasses the cache and re-probes', async () => {
    const { H } = await setupAdmin();
    const first = await request(app).get('/api/v1/admin/system/services').set(H);
    const rechecked = await request(app).post('/api/v1/admin/system/services/check').set(H);

    expect(rechecked.status).toBe(200);
    expect(rechecked.body.cached).toBe(false);
    // Same envelope AND same tile shape as the GET, so the console renders
    // both through one path.
    expect(Object.keys(rechecked.body.services[0]).sort()).toEqual(
      Object.keys(first.body.services[0]).sort()
    );

    const before = first.body.services.find((s) => s.key === 'postgres').checkedAt;
    const after = rechecked.body.services.find((s) => s.key === 'postgres').checkedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('reports a configured integration that fails its probe as down', async () => {
    const { H } = await setupAdmin();
    env.notifications.emailProvider = 'brevo';
    env.notifications.brevo.apiKey = 'test-key';
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.brevo.com'));

    const res = await request(app).post('/api/v1/admin/system/services/check').set(H);
    const email = res.body.services.find((s) => s.key === 'email');

    // Configured and unreachable is `down` — a different statement from
    // `not_configured`, which means nobody asked for it in the first place.
    expect(email.status).toBe('down');
    expect(email.detail).toContain('ENOTFOUND');
    expect(typeof email.latencyMs).toBe('number');
    fetchSpy.mockRestore();
  });

  it('refuses a non-admin on the check endpoint too', async () => {
    const { H } = await setupPlain();
    expect((await request(app).post('/api/v1/admin/system/services/check').set(H)).status).toBe(403);
  });

  it('reports a failing probe as down instead of failing the request', async () => {
    const { H } = await setupAdmin();
    // A services page that 500s when a service is down is useless exactly
    // when it is needed, so a thrown probe must still render a tile.
    // Only the probe's own query fails — `authenticate` queries the database
    // on the way in, and breaking that would 401/500 before routing and prove
    // nothing about the probe.
    const realQuery = db.sequelize.query.bind(db.sequelize);
    const spy = jest.spyOn(db.sequelize, 'query').mockImplementation((sql, ...rest) => {
      if (typeof sql === 'string' && sql.trim() === 'SELECT 1') {
        return Promise.reject(new Error('connection refused'));
      }
      return realQuery(sql, ...rest);
    });

    const res = await request(app).post('/api/v1/admin/system/services/check').set(H);
    expect(res.status).toBe(200);

    const pg = res.body.services.find((s) => s.key === 'postgres');
    expect(pg.status).toBe('down');
    expect(pg.detail).toContain('connection refused');
    spy.mockRestore();
  });
});

describe('platform admin — overview metrics', () => {
  const DAY_MS = 86400000;
  const OVERVIEW = '/api/v1/admin/metrics/overview';

  /** Unique across the whole file: order numbers and tracking codes collide otherwise. */
  let seq = 0;
  const nextSeq = () => (seq += 1);

  const utcDay = (offsetDays = 0) => new Date(Date.now() - offsetDays * DAY_MS).toISOString().slice(0, 10);
  const utcMonth = () => new Date().toISOString().slice(0, 7);

  async function setupAdminWithToken() {
    const auth = await registerAndActivate();
    const workspace = await createWorkspace(auth.accessToken, 'Admin Co');
    await db.User.update({ platformAdmin: true }, { where: { id: auth.userId } });
    return { auth, wid: workspace.id, H: { Authorization: `Bearer ${auth.accessToken}` } };
  }

  /** One standing order. `contactSnapshot` is NOT NULL, so it cannot be skipped. */
  async function makeOrder(workspaceId, { currency = 'EGP', total = 10000, cancelledAt = null } = {}) {
    const n = nextSeq();
    const customer = await db.Customer.create({
      workspaceId,
      phoneNormalized: `2010${String(n).padStart(8, '0')}`,
      fullName: 'Shopper',
    });
    return db.Order.create({
      workspaceId,
      customerId: customer.id,
      orderNumber: `ORD-${n}`,
      paymentMethod: 'cod',
      currency,
      subtotalAmount: total,
      totalAmount: total,
      contactSnapshot: { phone: customer.phoneNormalized },
      cancelledAt,
    });
  }

  function makeShipment(workspaceId, orderId, status) {
    return db.Shipment.create({
      workspaceId,
      orderId,
      trackingCode: `zg${String(nextSeq()).padStart(9, '0')}`,
      carrierCode: 'manual',
      status,
    });
  }

  async function makePaidInvoice(workspaceId, { amount, currency }) {
    const sub = await db.Subscription.findOne({ where: { workspaceId } });
    const now = new Date();
    return db.BillingInvoice.create({
      workspaceId,
      subscriptionId: sub.id,
      amount,
      currency,
      status: 'paid',
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * DAY_MS),
      paidAt: now,
    });
  }

  it('answers under the `overview` key, with every series zero-filled', async () => {
    const { H } = await setupAdminWithToken();
    const res = await request(app).get(OVERVIEW).set(H);

    expect(res.status).toBe(200);
    // A bare object is rejected by the console's single-record unwrap rather
    // than guessed at, so the key itself is part of the contract.
    expect(res.body.overview).toEqual(expect.any(Object));
    const { overview } = res.body;
    expect(Date.parse(overview.generatedAt)).not.toBeNaN();

    // Zero-filled means every bucket is present — the client never has to tell
    // "no activity" apart from "no data".
    for (const series of ['signupsPerDay', 'ordersPerDay']) {
      expect(overview[series]).toHaveLength(30);
      // Raw ISO keys, never pre-formatted: the console re-formats them, and an
      // Arabic-mode console cannot re-format "Sep 16".
      expect(overview[series][29].label).toBe(utcDay(0));
      expect(overview[series][0].label).toBe(utcDay(29));
      expect(overview[series].every((p) => typeof p.value === 'number')).toBe(true);
    }

    expect(Array.isArray(overview.attention)).toBe(true);
    // Derived by the console from /admin/workspaces; two sources for one table
    // is the bug this omission prevents.
    expect(overview.workspaces).toBeUndefined();
    expect(overview.recentSignups).toBeUndefined();
  });

  it('counts the workspace that just signed up in today’s bucket', async () => {
    const { H } = await setupAdminWithToken();
    const res = await request(app).get(OVERVIEW).set(H);

    const today = res.body.overview.signupsPerDay.find((p) => p.label === utcDay(0));
    expect(today.value).toBe(1);
  });

  it('totals GMV and today’s orders over one standing population', async () => {
    const { H, wid } = await setupAdminWithToken();
    await makeOrder(wid, { currency: 'EGP', total: 25000 });
    await makeOrder(wid, { currency: 'EGP', total: 15000 });
    // Cancelled orders leave every count they fed, so the three order numbers
    // all describe the same population.
    await makeOrder(wid, { currency: 'EGP', total: 99000, cancelledAt: new Date() });

    const { kpis, ordersPerDay } = (await request(app).get(OVERVIEW).set(H)).body.overview;
    expect(kpis.gmv30d).toBe(40000);
    expect(kpis.gmv30dCurrency).toBe('EGP');
    expect(kpis.ordersToday).toBe(2);
    expect(ordersPerDay.find((p) => p.label === utcDay(0)).value).toBe(2);
  });

  it('refuses to total GMV across currencies, and still shows the breakdown', async () => {
    const { H, wid } = await setupAdminWithToken();
    await makeOrder(wid, { currency: 'EGP', total: 25000 });
    await makeOrder(wid, { currency: 'USD', total: 4000 });

    const { kpis } = (await request(app).get(OVERVIEW).set(H)).body.overview;
    // There is no FX layer, so 29000 would be a fabricated number.
    expect(kpis.gmv30d).toBeNull();
    expect(kpis.gmv30dCurrency).toBeNull();
    expect(kpis.gmv30dByCurrency).toEqual({ EGP: 25000, USD: 4000 });
    // ...and the order count is unaffected: counting orders needs no currency.
    expect(kpis.ordersToday).toBe(2);
  });

  it('serves the same MRR as the subscriptions page, from the same total', async () => {
    const { H, wid } = await setupAdminWithToken();
    const plan = await db.Plan.create({
      key: 'usd-plan',
      name: 'usd-plan',
      monthlyPriceAmount: 29900,
      yearlyPriceAmount: 358800,
      currency: 'USD',
      trialDays: 0,
    });
    await db.Subscription.update(
      { status: 'active', planId: plan.id, billingCycle: 'monthly' },
      { where: { workspaceId: wid } }
    );

    const overview = (await request(app).get(OVERVIEW).set(H)).body.overview;
    const subs = (await request(app).get('/api/v1/admin/subscriptions').set(H)).body;

    // One total, computed once: the two pages cannot drift apart.
    expect(overview.kpis.mrr).toBe(subs.mrr);
    expect(overview.kpis.mrrCurrency).toBe(subs.mrrCurrency);
    expect(overview.kpis.mrr).toBe(29900);
    expect(overview.kpis.activeWorkspaces).toBe(1);
    expect(overview.kpis.trialing).toBe(0);
  });

  it('reports deliveryRate as a fraction, and null when nothing has finished', async () => {
    const { H, wid } = await setupAdminWithToken();
    const order = await makeOrder(wid);

    // Nothing terminal yet: in-flight parcels are not a delivery rate of zero.
    await makeShipment(wid, order.id, 'in_transit');
    let { kpis } = (await request(app).get(OVERVIEW).set(H)).body.overview;
    expect(kpis.deliveryRate).toBeNull();

    // Several shipments on one order is artificial, but the aggregation counts
    // shipments, not orders, and this keeps the fixture to a single order.
    await makeShipment(wid, order.id, 'delivered');
    await makeShipment(wid, order.id, 'delivered');
    await makeShipment(wid, order.id, 'failed');
    await makeShipment(wid, order.id, 'returned');

    ({ kpis } = (await request(app).get(OVERVIEW).set(H)).body.overview);
    // 2 delivered of 4 terminal. The in-transit one is not in the denominator.
    expect(kpis.deliveryRate).toBe(0.5);
  });

  it('raises a past-due subscription, with the days it has been overdue', async () => {
    const { H, wid } = await setupAdminWithToken();
    await db.Subscription.update(
      { status: 'past_due', currentPeriodEnd: new Date(Date.now() - 3 * DAY_MS) },
      { where: { workspaceId: wid } }
    );

    const { kpis, attention } = (await request(app).get(OVERVIEW).set(H)).body.overview;
    expect(kpis.pastDue).toBe(1);

    const row = attention.find((a) => a.kind === 'past_due');
    // The id matches the one the console's own fallback builds, so its list
    // keys survive the switch from derived to served data.
    expect(row.id).toBe(`past_due:${wid}`);
    expect(row.severity).toBe('danger');
    expect(row.workspaceName).toBe('Admin Co');
    expect(row.value).toBe(3);
    // No route and no prose: the console owns both.
    expect(row.to).toBeUndefined();
    expect(row.title).toBeUndefined();
  });

  it('raises a high return rate, but only once there is enough of it to mean anything', async () => {
    const { H, wid } = await setupAdminWithToken();
    const order = await makeOrder(wid);

    // 2 of 4 returned is a 50% RTO on a sample that says nothing — a rate on a
    // handful of parcels is noise, and flagging it trains the admin to ignore
    // the queue.
    await makeShipment(wid, order.id, 'returned');
    await makeShipment(wid, order.id, 'returned');
    await makeShipment(wid, order.id, 'delivered');
    await makeShipment(wid, order.id, 'delivered');
    let { attention } = (await request(app).get(OVERVIEW).set(H)).body.overview;
    expect(attention.find((a) => a.kind === 'high_rto')).toBeUndefined();

    // Past the minimum, 4 returned of 12 is a real 33%.
    for (let i = 0; i < 6; i += 1) await makeShipment(wid, order.id, 'delivered');
    await makeShipment(wid, order.id, 'returned');
    await makeShipment(wid, order.id, 'returned');

    ({ attention } = (await request(app).get(OVERVIEW).set(H)).body.overview);
    const row = attention.find((a) => a.kind === 'high_rto');
    expect(row.id).toBe(`high_rto:${wid}`);
    // A fraction, matching deliveryRate — the console renders the percentage.
    expect(row.value).toBeCloseTo(4 / 12, 4);
    expect(row.severity).toBe('warning');
    expect(row.workspaceName).toBe('Admin Co');
  });

  it('builds mrrTrend from paid invoices, and nulls it rather than drawing zeros', async () => {
    const { H, wid } = await setupAdminWithToken();

    // No paid invoice anywhere in the window is not twelve months of zero.
    expect((await request(app).get(OVERVIEW).set(H)).body.overview.mrrTrend).toBeNull();

    await makePaidInvoice(wid, { amount: 29900, currency: 'USD' });
    const overview = (await request(app).get(OVERVIEW).set(H)).body.overview;
    expect(overview.mrrTrend).toHaveLength(12);
    expect(overview.mrrTrend[11]).toEqual({ label: utcMonth(), value: 29900 });
    expect(overview.mrrTrendCurrency).toBe('USD');
  });

  it('nulls mrrTrend when the paid invoices span currencies', async () => {
    const { H, wid } = await setupAdminWithToken();
    await makePaidInvoice(wid, { amount: 29900, currency: 'USD' });
    await makePaidInvoice(wid, { amount: 500000, currency: 'EGP' });

    const overview = (await request(app).get(OVERVIEW).set(H)).body.overview;
    // A line whose unit changes partway along is not a line anyone can read,
    // and summing the two would make it look like growth.
    expect(overview.mrrTrend).toBeNull();
    expect(overview.mrrTrendCurrency).toBeNull();
  });
});
