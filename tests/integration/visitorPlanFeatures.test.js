'use strict';

// The Visitors section by plan (PLAN_FEATURE_ENFORCEMENT): the summary needs
// advanced_analytics; the visits, one visit, the outcomes per governorate and
// the campaigns need visitor_insights as well. The console and the events
// guard ignore the plan.

const crypto = require('crypto');
const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const ORIGINAL = { enforcement: env.planFeatures.enforcement, details: env.trafficDetails.enabled, guard: env.trafficGuard.enabled };
afterEach(() => {
  env.planFeatures.enforcement = ORIGINAL.enforcement;
  env.trafficDetails.enabled = ORIGINAL.details;
  env.trafficGuard.enabled = ORIGINAL.guard;
});

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function storeOn(features) {
  const plan = await db.Plan.create({
    key: `vp${crypto.randomBytes(4).toString('hex')}`,
    name: 'Plan',
    currency: 'EGP',
    monthlyPriceAmount: 10000,
    yearlyPriceAmount: 100000,
    trialDays: 14,
    isActive: true,
    isPublic: true,
    features,
  });
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Plan Store');
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: workspace.id } });
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const get = (path) => request(app).get(`/api/v1/workspaces/${workspace.id}/analytics/visitors${path}`).set(H);
  return { workspace, H, get };
}

const INSIGHTS = ['/sessions?range=7d', '/sessions/session-plan-1', '/campaigns?range=7d', '/governorates'];

async function withVisit(ctx) {
  env.trafficDetails.enabled = true;
  const res = await request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/events`)
    .set('User-Agent', UA)
    .send({ visitorId: 'visitor-plan-1', sessionId: 'session-plan-1', events: [{ name: 'page_view', path: '/' }] });
  expect(res.status).toBe(202);
}

describe('Visitors by plan', () => {
  it('enforcement off: everything opens, whatever the plan', async () => {
    const ctx = await storeOn([]);
    await withVisit(ctx);
    expect((await ctx.get('/summary?range=7d')).status).toBe(200);
    for (const path of INSIGHTS) expect([path, (await ctx.get(path)).status]).toEqual([path, 200]);
  });

  it('advanced_analytics only: the summary opens, the four detailed screens answer 403 visitor_insights', async () => {
    env.planFeatures.enforcement = true;
    const ctx = await storeOn(['advanced_analytics']);
    await withVisit(ctx);
    const summary = await ctx.get('/summary?range=7d');
    expect(summary.status).toBe(200);
    expect(summary.body.visits).toBe(1);
    for (const path of INSIGHTS) {
      const res = await ctx.get(path);
      expect([path, res.status, res.body.error.code]).toEqual([path, 403, 'PLAN_FEATURE_REQUIRED']);
      expect(res.body.error.details).toEqual({ feature: 'visitor_insights', label: { en: 'Visitor insights', ar: 'تحليلات الزوار المفصّلة' } });
    }
  });

  it('both features: every screen opens', async () => {
    env.planFeatures.enforcement = true;
    const ctx = await storeOn(['advanced_analytics', 'visitor_insights']);
    await withVisit(ctx);
    expect((await ctx.get('/summary?range=7d')).status).toBe(200);
    for (const path of INSIGHTS) expect([path, (await ctx.get(path)).status]).toEqual([path, 200]);
  });

  it('visitor_insights without advanced_analytics: still refused, naming advanced_analytics first', async () => {
    env.planFeatures.enforcement = true;
    const ctx = await storeOn(['visitor_insights']);
    for (const path of ['/summary?range=7d', ...INSIGHTS]) {
      const res = await ctx.get(path);
      expect([path, res.status, res.body.error.details.feature]).toEqual([path, 403, 'advanced_analytics']);
    }
  });

  it('a console grant opens it for one store without changing its plan', async () => {
    env.planFeatures.enforcement = true;
    const ctx = await storeOn(['advanced_analytics']);
    const admin = await makePlatformUser('admin');
    const grant = await request(app)
      .post(`/api/v1/admin/workspaces/${ctx.workspace.id}/feature-overrides`)
      .set(admin.H)
      .send({ featureKey: 'visitor_insights', mode: 'grant', reason: 'Pilot store' });
    expect(grant.status).toBe(201);
    expect((await ctx.get('/sessions?range=7d')).status).toBe(200);
  });

  it('the console and the events guard ignore the plan', async () => {
    env.planFeatures.enforcement = true;
    env.trafficGuard.enabled = true;
    const ctx = await storeOn([]);
    await withVisit(ctx);
    // The guard still answers a bot as a bot on a store with no analytics in its plan.
    const bot = await request(app).post(`/api/v1/store/${ctx.workspace.id}/events`).set('User-Agent', 'curl/8.4.0').send({
      visitorId: 'visitor-plan-2',
      sessionId: 'session-plan-2',
      events: [{ name: 'page_view', path: '/' }],
    });
    expect(bot.body).toEqual({ accepted: 0, bot: true });

    const admin = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['workspaces.view'] }, { where: { id: admin.userId } });
    for (const path of ['summary', 'sessions', 'campaigns', 'governorates', 'protection']) {
      const res = await request(app).get(`/api/v1/admin/store-traffic/${path}?workspaceId=${ctx.workspace.id}`).set(admin.H);
      expect([path, res.status]).toEqual([path, 200]);
    }
    const one = await request(app).get(`/api/v1/admin/store-traffic/sessions/${ctx.workspace.id}/session-plan-1`).set(admin.H);
    expect(one.status).toBe(200);
  });
});
