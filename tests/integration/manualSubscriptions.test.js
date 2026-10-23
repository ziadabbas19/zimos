'use strict';

// A platform admin setting one store's subscription by hand
// (billing/manualSubscriptionService) and its features on top of the plan
// (billing/entitlementsService).

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const { addMonths } = require('../../src/modules/billing/planPricing');

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_MODE = env.billing.restrictions;

beforeEach(async () => {
  env.billing.restrictions = 'enforce';
  await billingService.seedDefaultPlans();
});
afterAll(() => {
  env.billing.restrictions = ORIGINAL_MODE;
});

async function store(name = 'Manual Store') {
  const owner = await registerAndActivate();
  const res = await request(app).post('/api/v1/workspaces').set('Authorization', `Bearer ${owner.accessToken}`).send({ name });
  return { wid: res.body.workspace.id, H: { Authorization: `Bearer ${owner.accessToken}` } };
}

const plan = (key) => db.Plan.findOne({ where: { key } });
const sub = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });
const post = (actor, wid, path, body, key) => {
  const req = request(app).post(`/api/v1/admin/workspaces/${wid}/subscription/${path}`).set(actor.H);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};
const near = (a, b, ms = 5000) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) < ms;

describe('manual subscription', () => {
  it('activates a plan for a period, by hand, with no charge and no commission', async () => {
    const { wid } = await store();
    const admin = await makePlatformUser('admin');
    const growth = await plan('growth');

    const res = await post(admin, wid, 'activate', { planId: growth.id, duration: { months: 3 }, note: 'Paid by bank transfer, ref 55' });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    const s = await sub(wid);
    expect(s).toMatchObject({ planId: growth.id, status: 'active' });
    expect(near(s.currentPeriodStart, Date.now())).toBe(true);
    expect(near(s.currentPeriodEnd, addMonths(s.currentPeriodStart, 3))).toBe(true);
    expect(res.body.subscription).toMatchObject({ source: 'manual_admin', phase: 'ok', plan: { id: growth.id } });
    expect(res.body.history[0]).toMatchObject({ action: 'activate', source: 'manual_admin', note: 'Paid by bank transfer, ref 55' });

    // No charge, no invoice, no commission: recording a payment stays the only way to one.
    expect(await db.BillingInvoice.count({ where: { workspaceId: wid } })).toBe(0);
    expect(await db.AgentCommission.count({ where: { workspaceId: wid } })).toBe(0);

    const [audit] = await db.AuditLog.findAll({ where: { action: 'subscription.manual_activate' } });
    expect(audit).toMatchObject({ actorUserId: admin.userId, workspaceId: wid, metadata: expect.objectContaining({ source: 'manual_admin' }) });
  });

  it('takes an explicit end, a start in the past, or days', async () => {
    const { wid } = await store();
    const admin = await makePlatformUser('admin');
    const starter = await plan('starter');
    const startsAt = new Date(Date.now() - 5 * DAY_MS).toISOString();
    const endsAt = new Date(Date.now() + 20 * DAY_MS).toISOString();
    expect((await post(admin, wid, 'activate', { planId: starter.id, startsAt, endsAt, note: 'Partner deal' })).status).toBe(201);
    const s = await sub(wid);
    expect(near(s.currentPeriodStart, startsAt)).toBe(true);
    expect(near(s.currentPeriodEnd, endsAt)).toBe(true);
    expect((await post(admin, wid, 'activate', { planId: starter.id, duration: { days: 10 }, note: 'Trial for press' })).status).toBe(201);
  });

  it('refuses nonsense: unknown plan, bad durations, a past end, a future start, no note', async () => {
    const { wid } = await store();
    const admin = await makePlatformUser('admin');
    const starter = await plan('starter');
    const inactive = await db.Plan.create({ key: 'retired', name: 'Retired', monthlyPriceAmount: 100, yearlyPriceAmount: 1000, isActive: false });
    const bad = [
      { planId: '00000000-0000-4000-8000-000000000000', duration: { months: 1 }, note: 'x note' },
      { planId: inactive.id, duration: { months: 1 }, note: 'x note' },
      { planId: starter.id, duration: { months: 0 }, note: 'x note' },
      { planId: starter.id, duration: { months: 61 }, note: 'x note' },
      { planId: starter.id, duration: { days: 1827 }, note: 'x note' },
      { planId: starter.id, duration: { months: 1, days: 2 }, note: 'x note' },
      { planId: starter.id, endsAt: new Date(Date.now() - DAY_MS).toISOString(), note: 'x note' },
      { planId: starter.id, endsAt: new Date(Date.now() + 6 * 365 * DAY_MS).toISOString(), note: 'x note' },
      { planId: starter.id, startsAt: new Date(Date.now() + 3 * DAY_MS).toISOString(), duration: { months: 1 }, note: 'x note' },
      { planId: starter.id, duration: { months: 1 }, endsAt: new Date(Date.now() + 9 * DAY_MS).toISOString(), note: 'x note' },
      { planId: starter.id, duration: { months: 1 } },
      { planId: starter.id, duration: { months: 1 }, note: '  ' },
    ];
    for (const body of bad) {
      const res = await post(admin, wid, 'activate', body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect(await db.SubscriptionManualChange.count()).toBe(0);
  });

  it('makes a double click one change (Idempotency-Key)', async () => {
    const { wid } = await store();
    const admin = await makePlatformUser('admin');
    const starter = await plan('starter');
    const body = { planId: starter.id, duration: { months: 1 }, note: 'Cash at the office' };
    const [a, b] = await Promise.all([post(admin, wid, 'activate', body, 'click-1'), post(admin, wid, 'activate', body, 'click-1')]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await db.SubscriptionManualChange.count({ where: { workspaceId: wid } })).toBe(1);
    const other = await post(admin, wid, 'activate', { ...body, duration: { months: 2 } }, 'click-1');
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('is for creators and admins only', async () => {
    const { wid, H } = await store();
    const starter = await plan('starter');
    const body = { planId: starter.id, duration: { months: 1 }, note: 'Not allowed' };
    const agent = await makePlatformUser('agent');
    expect((await post(agent, wid, 'activate', body)).status).toBe(403);
    expect((await post({ H }, wid, 'activate', body)).status).toBe(403);
    expect((await request(app).get(`/api/v1/admin/workspaces/${wid}/subscription`).set(agent.H)).status).toBe(403);
    const creator = await makePlatformUser('creator');
    expect((await post(creator, wid, 'activate', body)).status).toBe(201);
  });

  it('changes the plan keeping the dates, and extends from the end — or from now once lapsed', async () => {
    const { wid } = await store();
    const admin = await makePlatformUser('admin');
    const starter = await plan('starter');
    const growth = await plan('growth');
    await post(admin, wid, 'activate', { planId: starter.id, duration: { months: 1 }, note: 'Start' });
    const before = await sub(wid);

    const changed = await post(admin, wid, 'change-plan', { planId: growth.id, note: 'Upgrade agreed on call' });
    expect(changed.status).toBe(201);
    const after = await sub(wid);
    expect(after.planId).toBe(growth.id);
    expect(after.currentPeriodEnd.getTime()).toBe(before.currentPeriodEnd.getTime());
    expect((await post(admin, wid, 'change-plan', { planId: growth.id, note: 'Again' })).status).toBe(409);

    await post(admin, wid, 'extend', { duration: { days: 15 }, note: 'Goodwill' });
    expect(near((await sub(wid)).currentPeriodEnd, before.currentPeriodEnd.getTime() + 15 * DAY_MS)).toBe(true);

    await db.Subscription.update({ status: 'past_due', currentPeriodEnd: new Date(Date.now() - 10 * DAY_MS) }, { where: { workspaceId: wid } });
    await post(admin, wid, 'extend', { duration: { days: 30 }, note: 'Back after a gap' });
    const lapsed = await sub(wid);
    expect(lapsed.status).toBe('active');
    expect(near(lapsed.currentPeriodEnd, Date.now() + 30 * DAY_MS)).toBe(true);
  });

  it('follows the lifecycle when the manual period ends: warning, grace, restriction — and a new one lifts it', async () => {
    const { wid, H } = await store();
    const admin = await makePlatformUser('admin');
    const starter = await plan('starter');
    const createProduct = () =>
      request(app).post(`/api/v1/workspaces/${wid}/catalog/products`).set(H).send({ name: 'Blocked?', status: 'draft' });

    await post(admin, wid, 'activate', { planId: starter.id, duration: { days: 2 }, note: 'Short' });
    expect((await request(app).get(`/api/v1/admin/workspaces/${wid}/subscription`).set(admin.H)).body.subscription.phase).toBe('expiring');

    // Ended now: past due, one day of grace, the store still open.
    expect((await post(admin, wid, 'end', { note: 'Chargeback' })).status).toBe(201);
    const ended = (await request(app).get(`/api/v1/admin/workspaces/${wid}/subscription`).set(admin.H)).body.subscription;
    expect(ended).toMatchObject({ status: 'past_due', phase: 'grace' });
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(200);
    expect((await post(admin, wid, 'end', { note: 'Twice' })).status).toBe(409);

    // A day and more later: restricted, new products refused.
    await db.Subscription.update({ currentPeriodEnd: new Date(Date.now() - 2 * DAY_MS) }, { where: { workspaceId: wid } });
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(423);
    expect((await createProduct()).status).toBe(402);

    await post(admin, wid, 'activate', { planId: starter.id, duration: { months: 1 }, note: 'Paid again' });
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(200);
    expect((await createProduct()).status).toBe(201);
    expect((await request(app).get(`/api/v1/workspaces/${wid}/access`).set(H)).body.access.restricted).toBe(false);
  });
});

describe('feature overrides', () => {
  const featuresOf = (actor, wid) => request(app).get(`/api/v1/admin/workspaces/${wid}/features`).set(actor.H);
  const add = (actor, wid, body) => request(app).post(`/api/v1/admin/workspaces/${wid}/feature-overrides`).set(actor.H).send(body);
  const byKey = (res, key) => res.body.features.find((f) => f.key === key);

  async function withPlanFeatures(features) {
    const s = await store();
    const starter = await plan('starter');
    await starter.update({ features });
    await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: s.wid } });
    return s;
  }

  it('grants and denies on top of the plan, and the store sees the merged result', async () => {
    const { wid, H } = await withPlanFeatures(['funnels', 'custom_domain']);
    const admin = await makePlatformUser('admin');

    expect(byKey(await featuresOf(admin, wid), 'funnels')).toMatchObject({ enabled: true, source: 'plan' });
    expect((await add(admin, wid, { featureKey: 'multi_warehouse', mode: 'grant', reason: 'Warehouse pilot' })).status).toBe(201);
    expect((await add(admin, wid, { featureKey: 'funnels', mode: 'deny', reason: 'Abuse report' })).status).toBe(201);

    const res = await featuresOf(admin, wid);
    expect(byKey(res, 'multi_warehouse')).toMatchObject({ enabled: true, source: 'override', inPlan: false });
    expect(byKey(res, 'funnels')).toMatchObject({ enabled: false, source: 'override', inPlan: true });
    const billing = await request(app).get(`/api/v1/workspaces/${wid}/billing`).set(H);
    // The merchant sees only features that exist today (billing/featureCatalog):
    // the multi_warehouse grant applies (the console row above) but isn't listed to them.
    expect(billing.body.billing.features.sort()).toEqual(['custom_domain']);
  });

  it('refuses keys outside the catalogue, values for on/off features, past expiries and a second live override', async () => {
    const { wid } = await withPlanFeatures([]);
    const admin = await makePlatformUser('admin');
    expect((await add(admin, wid, { featureKey: 'teleport', mode: 'grant', reason: 'Nope' })).status).toBe(422);
    expect((await add(admin, wid, { featureKey: 'funnels', mode: 'grant', value: 5, reason: 'Nope' })).status).toBe(422);
    expect((await add(admin, wid, { featureKey: 'funnels', mode: 'grant', expiresAt: new Date(Date.now() - 1000).toISOString(), reason: 'Nope' })).status).toBe(422);
    expect((await add(admin, wid, { featureKey: 'funnels', mode: 'maybe', reason: 'Nope' })).status).toBe(422);
    expect((await add(admin, wid, { featureKey: 'funnels', mode: 'grant' })).status).toBe(422);
    expect((await add(admin, wid, { featureKey: 'funnels', mode: 'grant', reason: 'First' })).status).toBe(201);
    const second = await add(admin, wid, { featureKey: 'funnels', mode: 'deny', reason: 'Second' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('FEATURE_OVERRIDE_EXISTS');
  });

  it('stops applying when it expires or is revoked; an expired one can be replaced', async () => {
    const { wid } = await withPlanFeatures(['funnels']);
    const admin = await makePlatformUser('admin');
    const denied = (await add(admin, wid, { featureKey: 'funnels', mode: 'deny', reason: 'Temporary', expiresAt: new Date(Date.now() + DAY_MS).toISOString() })).body.override;

    await db.WorkspaceFeatureOverride.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: denied.id } });
    const expired = byKey(await featuresOf(admin, wid), 'funnels');
    expect(expired).toMatchObject({ enabled: true, source: 'plan' });
    expect(expired.expiredOverride).toMatchObject({ id: denied.id, state: 'expired' });

    const granted = await add(admin, wid, { featureKey: 'funnels', mode: 'deny', reason: 'Again' });
    expect(granted.status).toBe(201);
    expect((await db.WorkspaceFeatureOverride.findByPk(denied.id)).revokedAt).not.toBeNull();

    const revoke = await request(app)
      .post(`/api/v1/admin/workspaces/${wid}/feature-overrides/${granted.body.override.id}/revoke`)
      .set(admin.H)
      .send({ reason: 'Resolved' });
    expect(revoke.status).toBe(200);
    expect(byKey(await featuresOf(admin, wid), 'funnels')).toMatchObject({ enabled: true, source: 'plan' });
    const history = (await featuresOf(admin, wid)).body.overrides.map((o) => o.state);
    expect(history).toEqual(['revoked', 'revoked']);
    expect(await db.AuditLog.count({ where: { workspaceId: wid, entityType: 'WorkspaceFeatureOverride' } })).toBe(3);
  });

  it('edits an override, stays within its store, and is for creators and admins', async () => {
    const a = await withPlanFeatures([]);
    const b = await withPlanFeatures([]);
    const admin = await makePlatformUser('admin');
    const o = (await add(admin, a.wid, { featureKey: 'remove_branding', mode: 'grant', reason: 'Enterprise' })).body.override;

    const edit = await request(app)
      .patch(`/api/v1/admin/workspaces/${a.wid}/feature-overrides/${o.id}`)
      .set(admin.H)
      .send({ mode: 'deny', reason: 'Changed' });
    expect(edit.status).toBe(200);
    expect(edit.body.override).toMatchObject({ mode: 'deny', reason: 'Changed' });
    // Another store's path does not reach it, and its features are its own.
    expect((await request(app).patch(`/api/v1/admin/workspaces/${b.wid}/feature-overrides/${o.id}`).set(admin.H).send({ mode: 'grant' })).status).toBe(404);
    expect(byKey(await featuresOf(admin, b.wid), 'remove_branding')).toMatchObject({ enabled: false, source: 'none' });

    const agent = await makePlatformUser('agent');
    expect((await add(agent, a.wid, { featureKey: 'funnels', mode: 'grant', reason: 'Nope' })).status).toBe(403);
    expect((await featuresOf(agent, a.wid)).status).toBe(403);
  });
});
