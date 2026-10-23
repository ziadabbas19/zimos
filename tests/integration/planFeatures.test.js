'use strict';

/**
 * Plan features: the catalogue as the one source (billing/featureCatalog),
 * what merchants and visitors are shown, what the console may save, the
 * console's plan order, and the PLAN_FEATURE_ENFORCEMENT gate
 * (billing/planFeatureGate).
 */

const crypto = require('crypto');
const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { lookupTxt } = require('../../src/modules/domains/dnsVerifier');

jest.mock('../../src/modules/domains/dnsVerifier', () => ({ lookupTxt: jest.fn() }));

// The domains routes are closed unless CUSTOM_DOMAINS_ENABLED (domains/domainsGate.js).
beforeAll(() => {
  env.customDomains.enabled = true;
});
afterAll(() => {
  env.customDomains.enabled = false;
});

const ORIGINAL_ENFORCEMENT = env.planFeatures.enforcement;
afterEach(() => {
  env.planFeatures.enforcement = ORIGINAL_ENFORCEMENT;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const key = () => `pf${crypto.randomBytes(4).toString('hex')}`;

async function makePlan(overrides = {}) {
  return db.Plan.create({
    key: key(),
    name: 'Plan',
    currency: 'EGP',
    monthlyPriceAmount: 10000,
    yearlyPriceAmount: 100000,
    trialDays: 14,
    isActive: true,
    isPublic: true,
    features: [],
    ...overrides,
  });
}

/** A store of its own owner, moved onto `plan` (or left on the default). */
async function storeOn(plan, name = 'Feature Store') {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, name);
  if (plan) await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: workspace.id } });
  return { owner, wid: workspace.id, H: bearer(owner.accessToken) };
}

const REAL_AND_FAKE = ['funnels', 'api_access', 'remove_branding', 'staff_accounts', 'multi_warehouse', 'priority_support', 'abandoned_cart'];
const SHOWN = ['funnels', 'api_access', 'remove_branding', 'staff_accounts', 'priority_support', 'abandoned_cart'];

describe('the feature catalogue', () => {
  it('marks the one feature with nothing behind it unavailable, and the rest available', async () => {
    const admin = await makePlatformUser('admin');
    const res = await request(app).get('/api/v1/admin/plans').set(admin.H);
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.featureCatalog.map((f) => [f.key, f]));
    expect(Object.keys(byKey)).toHaveLength(11);
    expect(byKey.multi_warehouse.available).toBe(false);
    for (const k of ['custom_domain', 'funnels', 'whatsapp_confirmation', 'abandoned_cart', 'api_access', 'staff_accounts', 'advanced_analytics', 'visitor_insights', 'remove_branding', 'priority_support']) {
      expect(byKey[k].available).toBe(true);
    }
    expect(byKey.staff_accounts.label).toEqual({ en: 'Staff accounts', ar: 'حسابات الفريق' });
  });
});

describe('what merchants and visitors are shown', () => {
  it('drops unavailable keys from the public plans, and keeps them stored', async () => {
    const plan = await makePlan({ name: 'Mixed', features: REAL_AND_FAKE });
    const res = await request(app).get('/api/v1/plans/public');
    expect(res.status).toBe(200);
    const row = res.body.plans.find((p) => p.id === plan.id);
    expect(row.features).toEqual(SHOWN);
    await plan.reload();
    expect(plan.features).toEqual(REAL_AND_FAKE);
  });

  it('drops them from the merchant’s billing summary and from the Subscription section’s plans', async () => {
    const plan = await makePlan({ name: 'Mixed', features: REAL_AND_FAKE });
    const { wid, H } = await storeOn(plan);

    const billing = await request(app).get(`/api/v1/workspaces/${wid}/billing`).set(H);
    expect(billing.status).toBe(200);
    expect(billing.body.billing.subscription.plan.features).toEqual(SHOWN);
    expect([...billing.body.billing.features].sort()).toEqual([...SHOWN].sort());

    const plans = await request(app).get(`/api/v1/workspaces/${wid}/billing/plans`).set(H);
    expect(plans.status).toBe(200);
    const row = plans.body.plans.find((p) => (p.planId || p.id) === plan.id);
    expect(row.features).toEqual(SHOWN);
  });
});

describe('saving a plan in the console', () => {
  const body = (features, extra = {}) => ({
    code: key(),
    name: 'Console Plan',
    monthlyPrice: 20000,
    currency: 'EGP',
    trialDays: 7,
    features,
    ...extra,
  });

  it('refuses a new plan with a feature that is not available (422 PLAN_FEATURE_NOT_AVAILABLE)', async () => {
    const admin = await makePlatformUser('admin');
    const res = await request(app).post('/api/v1/admin/plans').set(admin.H).send(body(['funnels', 'multi_warehouse']));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PLAN_FEATURE_NOT_AVAILABLE');
    expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'features', key: 'multi_warehouse' })]);
    expect(await db.Plan.count({ where: { name: 'Console Plan' } })).toBe(0);
  });

  it('refuses adding one to an existing plan, and a key outside the catalogue', async () => {
    const admin = await makePlatformUser('admin');
    const created = await request(app).post('/api/v1/admin/plans').set(admin.H).send(body(['funnels']));
    expect(created.status).toBe(201);
    const id = created.body.plan.id;
    const added = await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send(body(['funnels', 'multi_warehouse'], { code: created.body.plan.code }));
    expect(added.status).toBe(422);
    expect(added.body.error.code).toBe('PLAN_FEATURE_NOT_AVAILABLE');
    const unknown = await request(app).patch(`/api/v1/admin/plans/${id}`).set(admin.H).send(body(['funnels', 'teleport'], { code: created.body.plan.code }));
    expect(unknown.status).toBe(422);
    expect((await db.Plan.findByPk(id)).features).toEqual(['funnels']);
  });

  it('saves an older plan that already lists one, unchanged, and lets it be removed', async () => {
    const admin = await makePlatformUser('admin');
    const old = await makePlan({ name: 'Old', features: ['funnels', 'multi_warehouse'] });
    const same = await request(app)
      .patch(`/api/v1/admin/plans/${old.id}`)
      .set(admin.H)
      .send(body(['funnels', 'multi_warehouse'], { code: old.key, name: 'Old renamed' }));
    expect(same.status).toBe(200);
    expect(same.body.plan.features).toEqual(['funnels', 'multi_warehouse']);
    expect(same.body.plan.name).toBe('Old renamed');

    const removed = await request(app).patch(`/api/v1/admin/plans/${old.id}`).set(admin.H).send(body(['funnels'], { code: old.key }));
    expect(removed.status).toBe(200);
    expect(removed.body.plan.features).toEqual(['funnels']);
    // …and once removed, it can't come back.
    const back = await request(app).patch(`/api/v1/admin/plans/${old.id}`).set(admin.H).send(body(['funnels', 'multi_warehouse'], { code: old.key }));
    expect(back.status).toBe(422);
  });

  it('lists plans by display order, then price, then name — the pricing page’s order', async () => {
    const admin = await makePlatformUser('admin');
    await db.Plan.destroy({ where: {} });
    const c = await makePlan({ name: 'C', displayOrder: 2, monthlyPriceAmount: 100 });
    const b2 = await makePlan({ name: 'Bb', displayOrder: 1, monthlyPriceAmount: 900 });
    const b1 = await makePlan({ name: 'Ba', displayOrder: 1, monthlyPriceAmount: 900 });
    const a = await makePlan({ name: 'A', displayOrder: 1, monthlyPriceAmount: 50000 });
    const cheapFirst = await makePlan({ name: 'Z', displayOrder: 0, monthlyPriceAmount: 99999 });
    const res = await request(app).get('/api/v1/admin/plans').set(admin.H);
    expect(res.body.plans.map((p) => p.id)).toEqual([cheapFirst.id, b1.id, b2.id, a.id, c.id]);
    const pub = await request(app).get('/api/v1/plans/public');
    expect(pub.body.plans.map((p) => p.id)).toEqual([cheapFirst.id, b1.id, b2.id, a.id, c.id]);
  });

  it('keeps the catalogue and the editor to the console: merchants and view-only staff are refused', async () => {
    const { H } = await storeOn(null);
    expect((await request(app).get('/api/v1/admin/plans').set(H)).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/plans').set(H).send(body(['funnels']))).status).toBe(403);

    const viewer = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['plans.view'] }, { where: { id: viewer.userId } });
    expect((await request(app).get('/api/v1/admin/plans').set(viewer.H)).status).toBe(200);
    expect((await request(app).post('/api/v1/admin/plans').set(viewer.H).send(body(['funnels']))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/plans')).status).toBe(401);
  });
});

describe('PLAN_FEATURE_ENFORCEMENT', () => {
  const invite = async (ctx) => {
    const member = await registerAndActivate();
    const role = await db.Role.findOne({ where: { workspaceId: ctx.wid, key: 'editor' } });
    return request(app).post(`/api/v1/workspaces/${ctx.wid}/members`).set(ctx.H).send({ email: member.email, roleId: role.id });
  };
  const addDomain = (ctx, hostname = `www.${key()}.com`) =>
    request(app).post(`/api/v1/workspaces/${ctx.wid}/domains`).set(ctx.H).send({ hostname });
  const webStats = (ctx) => request(app).get(`/api/v1/workspaces/${ctx.wid}/analytics/web/stats`).set(ctx.H);
  const summary = (ctx) => request(app).get(`/api/v1/workspaces/${ctx.wid}/analytics/summary`).set(ctx.H);

  async function withWebsite(ctx) {
    const res = await request(app).post(`/api/v1/workspaces/${ctx.wid}/websites`).set(ctx.H).send({ name: 'Site' });
    if (res.status !== 201) throw new Error(`website: ${res.status} ${JSON.stringify(res.body)}`);
    return ctx;
  }

  it('off (the default): nothing is refused for a missing feature, as before', async () => {
    expect(env.planFeatures.enforcement).toBe(false);
    const ctx = await withWebsite(await storeOn(await makePlan({ features: [] })));
    expect((await invite(ctx)).status).toBe(201);
    expect((await addDomain(ctx)).status).toBe(201);
    expect((await webStats(ctx)).status).toBe(200);
  });

  it('on: refuses an invite, a domain and the web analytics with 403 PLAN_FEATURE_REQUIRED', async () => {
    env.planFeatures.enforcement = true;
    const ctx = await withWebsite(await storeOn(await makePlan({ features: ['funnels'] })));

    const inv = await invite(ctx);
    expect(inv.status).toBe(403);
    expect(inv.body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    expect(inv.body.error.details).toEqual({ feature: 'staff_accounts', label: { en: 'Staff accounts', ar: 'حسابات الفريق' } });
    expect(await db.Membership.count({ where: { workspaceId: ctx.wid } })).toBe(1);

    const dom = await addDomain(ctx);
    expect(dom.status).toBe(403);
    expect(dom.body.error.details.feature).toBe('custom_domain');
    expect(await db.Domain.count({ where: { workspaceId: ctx.wid } })).toBe(0);

    const web = await webStats(ctx);
    expect(web.status).toBe(403);
    expect(web.body.error.details.feature).toBe('advanced_analytics');

    // The summary the dashboard's home page reads stays open.
    expect((await summary(ctx)).status).toBe(200);
  });

  it('on: lets a store whose plan lists the feature through, and a console grant without changing the plan', async () => {
    env.planFeatures.enforcement = true;
    const withAll = await withWebsite(await storeOn(await makePlan({ features: ['staff_accounts', 'advanced_analytics', 'custom_domain'] })));
    expect((await invite(withAll)).status).toBe(201);
    expect((await addDomain(withAll)).status).toBe(201);
    expect((await webStats(withAll)).status).toBe(200);

    const granted = await withWebsite(await storeOn(await makePlan({ features: [] })));
    const admin = await makePlatformUser('admin');
    const g = await request(app)
      .post(`/api/v1/admin/workspaces/${granted.wid}/feature-overrides`)
      .set(admin.H)
      .send({ featureKey: 'custom_domain', mode: 'grant', reason: 'Pilot' });
    expect(g.status).toBe(201);
    expect((await addDomain(granted)).status).toBe(201);
    expect((await invite(granted)).status).toBe(403);
  });

  it('on: verifying a pending domain needs the feature too; listing and removing stay open', async () => {
    const ctx = await withWebsite(await storeOn(await makePlan({ features: [] })));
    const added = await addDomain(ctx, 'www.pendingshop.com');
    expect(added.status).toBe(201);
    env.planFeatures.enforcement = true;
    lookupTxt.mockResolvedValueOnce([[added.body.record.value]]);
    const verify = await request(app).post(`/api/v1/workspaces/${ctx.wid}/domains/${added.body.domain.id}/verify`).set(ctx.H);
    expect(verify.status).toBe(403);
    expect((await db.Domain.findByPk(added.body.domain.id)).status).toBe('pending_verification');
    expect((await request(app).get(`/api/v1/workspaces/${ctx.wid}/domains`).set(ctx.H)).status).toBe(200);
    expect((await request(app).delete(`/api/v1/workspaces/${ctx.wid}/domains/${added.body.domain.id}`).set(ctx.H)).status).toBe(200);
  });

  it('on: judges the store in the URL — one owner’s two stores on different plans — and a stranger never reaches the check', async () => {
    env.planFeatures.enforcement = true;
    const owner = await registerAndActivate();
    const H = bearer(owner.accessToken);
    const rich = await createWorkspace(owner.accessToken, 'Rich Store');
    const poor = await createWorkspace(owner.accessToken, 'Poor Store');
    await db.Subscription.update({ planId: (await makePlan({ features: ['staff_accounts'] })).id }, { where: { workspaceId: rich.id } });
    await db.Subscription.update({ planId: (await makePlan({ features: [] })).id }, { where: { workspaceId: poor.id } });

    expect((await invite({ wid: rich.id, H })).status).toBe(201);
    const refused = await invite({ wid: poor.id, H });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PLAN_FEATURE_REQUIRED');

    // Someone with no membership in the rich store is stopped before any feature check.
    const stranger = await registerAndActivate();
    const strangerInvite = await invite({ wid: rich.id, H: bearer(stranger.accessToken) });
    expect([403, 404]).toContain(strangerInvite.status);
    expect(strangerInvite.body.error.code).not.toBe('PLAN_FEATURE_REQUIRED');
  });

  it('on: a console deny takes the feature away from a plan that lists it', async () => {
    env.planFeatures.enforcement = true;
    const ctx = await storeOn(await makePlan({ features: ['advanced_analytics'] }));
    expect((await webStats(ctx)).status).toBe(200);
    const admin = await makePlatformUser('admin');
    await request(app)
      .post(`/api/v1/admin/workspaces/${ctx.wid}/feature-overrides`)
      .set(admin.H)
      .send({ featureKey: 'advanced_analytics', mode: 'deny', reason: 'Test' })
      .expect(201);
    expect((await webStats(ctx)).status).toBe(403);
  });
});
