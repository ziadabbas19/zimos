'use strict';

/**
 * The three plan features made real in one go: api_access (minting a key),
 * priority_support (the ticket's opening priority and the queue's order) and
 * remove_branding (the "Hide ZIMOS branding" setting, the storefront's
 * `removeBranding`, the sender name on a store's emails to its shoppers).
 * The catalogue and the gate itself are covered in planFeatures.test.js.
 */

jest.mock('../../src/modules/notifications/brevoEmailProvider', () => ({
  sendEmail: jest.fn().mockResolvedValue({ messageId: 'brevo-mock-1' }),
}));

const crypto = require('crypto');
const brevo = require('../../src/modules/notifications/brevoEmailProvider');
const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');

const ORIGINAL_ENFORCEMENT = env.planFeatures.enforcement;
afterEach(() => {
  env.planFeatures.enforcement = ORIGINAL_ENFORCEMENT;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const key = () => `pu${crypto.randomBytes(4).toString('hex')}`;

async function makePlan(features) {
  return db.Plan.create({
    key: key(),
    name: 'Plan',
    currency: 'EGP',
    monthlyPriceAmount: 10000,
    yearlyPriceAmount: 100000,
    trialDays: 14,
    isActive: true,
    isPublic: true,
    features,
  });
}

/** A store of its own owner, on a plan listing `features`. */
async function storeWith(features, name = 'Feature Store') {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, name);
  const plan = await makePlan(features);
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: workspace.id } });
  return { owner, wid: workspace.id, H: bearer(owner.accessToken) };
}

/** Moves the store onto a plan listing `features`: an upgrade or a downgrade. */
async function moveTo(ctx, features) {
  await db.Subscription.update({ planId: (await makePlan(features)).id }, { where: { workspaceId: ctx.wid } });
}

const mintKey = (ctx) => request(app).post(`/api/v1/workspaces/${ctx.wid}/api-keys`).set(ctx.H).send({ name: 'Fulfilment', scopes: ['orders:read'] });
const listKeys = (ctx) => request(app).get(`/api/v1/workspaces/${ctx.wid}/api-keys`).set(ctx.H);
const planFeatures = (ctx) => request(app).get(`/api/v1/workspaces/${ctx.wid}/plan-features`).set(ctx.H);

describe('api_access', () => {
  it('gate off: a key is minted on any plan', async () => {
    expect(env.planFeatures.enforcement).toBe(false);
    const ctx = await storeWith([]);
    expect((await mintKey(ctx)).status).toBe(201);
  });

  it('gate on: minting needs the feature, listing and revoking do not, and a key already minted keeps working', async () => {
    const ctx = await storeWith(['api_access']);
    const minted = await mintKey(ctx);
    expect(minted.status).toBe(201);
    const secret = minted.body.secret;

    // The store loses the feature.
    await moveTo(ctx, []);
    env.planFeatures.enforcement = true;

    const refused = await mintKey(ctx);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    expect(refused.body.error.details).toEqual({ feature: 'api_access', label: { en: 'API access', ar: 'الوصول عبر API' } });
    expect(await db.ApiKey.count({ where: { workspaceId: ctx.wid } })).toBe(1);

    const list = await listKeys(ctx);
    expect(list.status).toBe(200);
    expect(list.body.apiKeys.map((k) => k.id)).toEqual([minted.body.apiKey.id]);

    // The public API never asks about the plan.
    const me = await request(app).get('/api/v1/public/me').set(bearer(secret));
    expect(me.status).toBe(200);
    expect(me.body.workspaceId).toBe(ctx.wid);

    const revoked = await request(app).delete(`/api/v1/workspaces/${ctx.wid}/api-keys/${minted.body.apiKey.id}`).set(ctx.H);
    expect(revoked.status).toBe(200);
    expect(revoked.body.apiKey.revokedAt).not.toBeNull();
    expect((await request(app).get('/api/v1/public/me').set(bearer(secret))).status).toBe(401);
  });

  it('gate on: a plan with the feature, or a console grant, mints', async () => {
    env.planFeatures.enforcement = true;
    expect((await mintKey(await storeWith(['api_access']))).status).toBe(201);

    const granted = await storeWith([]);
    const admin = await makePlatformUser('admin');
    await request(app)
      .post(`/api/v1/admin/workspaces/${granted.wid}/feature-overrides`)
      .set(admin.H)
      .send({ featureKey: 'api_access', mode: 'grant', reason: 'Pilot' })
      .expect(201);
    expect((await mintKey(granted)).status).toBe(201);
  });

  it('GET /plan-features tells any member the keys the store holds and whether the gate is on', async () => {
    const ctx = await storeWith(['api_access', 'multi_warehouse', 'funnels']);
    const off = await planFeatures(ctx);
    expect(off.status).toBe(200);
    // Catalogue keys whose feature exists; multi_warehouse is still not one of them.
    expect(off.body.planFeatures).toEqual({ features: ['funnels', 'api_access'], enforced: false });

    env.planFeatures.enforcement = true;
    expect((await planFeatures(ctx)).body.planFeatures.enforced).toBe(true);

    // A member with no permission at all still reads it; a stranger does not.
    const member = await registerAndActivate();
    const viewer = await db.Role.findOne({ where: { workspaceId: ctx.wid, key: 'viewer' } });
    if (viewer) {
      await db.Membership.create({ workspaceId: ctx.wid, userId: member.userId, roleId: viewer.id, status: 'active' });
      expect((await planFeatures({ wid: ctx.wid, H: bearer(member.accessToken) })).status).toBe(200);
    }
    const stranger = await registerAndActivate();
    expect([403, 404]).toContain((await planFeatures({ wid: ctx.wid, H: bearer(stranger.accessToken) })).status);
  });
});

describe('priority_support', () => {
  const open = (ctx, subject = 'Help') =>
    request(app).post(`/api/v1/workspaces/${ctx.wid}/support/tickets`).set(ctx.H).send({ subject, body: 'Something is wrong.', category: 'technical' });

  it('a store with the feature opens its tickets at high priority; others at normal; nothing else changes for the merchant', async () => {
    const plain = await storeWith([]);
    const prioritised = await storeWith(['priority_support']);

    const normal = await open(plain);
    expect(normal.status).toBe(201);
    expect(normal.body.ticket.priority).toBe('normal');

    const high = await open(prioritised);
    expect(high.status).toBe(201);
    expect(high.body.ticket).toMatchObject({ priority: 'high', status: 'open' });
    expect(Object.keys(high.body.ticket).sort()).toEqual(Object.keys(normal.body.ticket).sort());

    // The console's grant counts like the plan, and the gate flag plays no part.
    expect(env.planFeatures.enforcement).toBe(false);
    const granted = await storeWith([]);
    const admin = await makePlatformUser('admin');
    await request(app)
      .post(`/api/v1/admin/workspaces/${granted.wid}/feature-overrides`)
      .set(admin.H)
      .send({ featureKey: 'priority_support', mode: 'grant', reason: 'VIP' })
      .expect(201);
    expect((await open(granted)).body.ticket.priority).toBe('high');

    // The audit row records the priority the ticket opened at.
    const audit = await db.AuditLog.findOne({ where: { action: 'support_ticket.create', entityId: high.body.ticket.id } });
    expect(audit.afterState.priority).toBe('high');
  });

  it('the queue lists urgent and high tickets first, then its usual order', async () => {
    const admin = await makePlatformUser('admin');
    const plain = await storeWith([], 'Plain Co');
    const prioritised = await storeWith(['priority_support'], 'Priority Co');

    const first = (await open(plain, 'Older normal')).body.ticket;
    const high = (await open(prioritised, 'Newer high')).body.ticket;
    const later = (await open(plain, 'Newest normal')).body.ticket;
    const urgent = (await open(plain, 'Made urgent')).body.ticket;
    await request(app).patch(`/api/v1/admin/support/tickets/${urgent.id}`).set(admin.H).send({ priority: 'urgent' }).expect(200);

    const queue = await request(app).get('/api/v1/admin/support/tickets?status=open').set(admin.H);
    expect(queue.status).toBe(200);
    expect(queue.body.tickets.map((t) => t.id)).toEqual([urgent.id, high.id, first.id, later.id]);

    const all = await request(app).get('/api/v1/admin/support/tickets').set(admin.H);
    expect(all.body.tickets.map((t) => t.id)).toEqual([urgent.id, high.id, later.id, first.id]);

    const onlyHigh = await request(app).get('/api/v1/admin/support/tickets?priority=high').set(admin.H);
    expect(onlyHigh.body.tickets.map((t) => t.id)).toEqual([high.id]);
  });
});

describe('remove_branding', () => {
  const store = (ctx) => request(app).get(`/api/v1/store/${ctx.wid}`);
  const hide = (ctx, on) =>
    request(app).patch(`/api/v1/workspaces/${ctx.wid}`).set(ctx.H).send({ settings: { general: { hide_platform_branding: on } } });
  const stored = async (ctx) => ((await db.Workspace.findByPk(ctx.wid)).settings.general || {}).hide_platform_branding;

  it('is off by default, and the setting alone or the feature alone changes nothing', async () => {
    const plain = await storeWith([]);
    expect((await store(plain)).body.store.removeBranding).toBe(false);

    expect((await hide(plain, true)).status).toBe(200);
    expect(await stored(plain)).toBe(true);
    expect((await store(plain)).body.store.removeBranding).toBe(false);

    const entitled = await storeWith(['remove_branding']);
    expect((await store(entitled)).body.store.removeBranding).toBe(false);
  });

  it('hides the branding while both hold, and a downgrade shows it again with nothing stored changed', async () => {
    const ctx = await storeWith(['remove_branding']);
    expect((await hide(ctx, true)).status).toBe(200);
    expect((await store(ctx)).body.store.removeBranding).toBe(true);
    // The storefront reads one flag; the setting itself stays out of the public payload.
    expect((await store(ctx)).body.store.general).toEqual({ faviconUrl: null, country: null });

    await moveTo(ctx, []);
    expect((await store(ctx)).body.store.removeBranding).toBe(false);
    expect(await stored(ctx)).toBe(true);

    await moveTo(ctx, ['remove_branding']);
    expect((await store(ctx)).body.store.removeBranding).toBe(true);

    expect((await hide(ctx, false)).status).toBe(200);
    expect((await store(ctx)).body.store.removeBranding).toBe(false);
    // Saving the blob without the key leaves it off, like any general setting sent whole.
    await hide(ctx, true);
    await request(app).patch(`/api/v1/workspaces/${ctx.wid}`).set(ctx.H).send({ settings: { general: { country: 'EG' } } }).expect(200);
    expect(await stored(ctx)).toBeUndefined();
    expect((await store(ctx)).body.store.removeBranding).toBe(false);
  });

  describe("the sender name on a store's emails to its shoppers", () => {
    const ORIGINAL_PROVIDER = env.notifications.emailProvider;
    beforeEach(() => {
      brevo.sendEmail.mockClear();
      env.notifications.emailProvider = 'brevo';
      env.notifications.brevo.apiKey = 'test-key';
      env.notifications.brevo.fromAddress = 'store@example.com';
      env.notifications.brevo.fromName = 'Zimos';
    });
    afterAll(() => {
      env.notifications.emailProvider = ORIGINAL_PROVIDER;
    });

    const backInStock = (ctx) =>
      notify.email({
        recipient: 'shopper@example.com',
        template: 'back_in_stock',
        data: { productName: 'Thing', url: 'https://shop.example.com/products/thing', storeName: 'Nile Store', locale: 'en' },
        workspaceId: ctx.wid,
      });
    const lastSend = () => brevo.sendEmail.mock.calls[brevo.sendEmail.mock.calls.length - 1][0];

    it("takes the store's name (and Reply-To) only while the branding is hidden", async () => {
      const ctx = await storeWith(['remove_branding'], 'Nile Store');
      expect((await backInStock(ctx)).status).toBe('sent');
      // As before: no name of its own, so the provider's EMAIL_FROM_NAME.
      expect(lastSend().fromName).toBeUndefined();
      expect(lastSend().replyTo).toBeUndefined();

      await hide(ctx, true);
      await backInStock(ctx);
      expect(lastSend().fromName).toBe('Nile Store');
      expect(lastSend().replyTo).toBeUndefined();

      // The name and Reply-To the merchant set for order emails apply to these too.
      await request(app).put(`/api/v1/workspaces/${ctx.wid}/order-emails/sender`).set(ctx.H).send({ fromName: 'Nile Team', replyTo: 'hello@nile.example' }).expect(200);
      await backInStock(ctx);
      expect(lastSend().fromName).toBe('Nile Team');
      expect(lastSend().replyTo).toBe('hello@nile.example');

      // A downgrade puts the platform's name back on its own.
      await moveTo(ctx, []);
      await backInStock(ctx);
      expect(lastSend().fromName).toBeUndefined();
    });

    it("leaves the platform's own emails alone", async () => {
      const ctx = await storeWith(['remove_branding'], 'Nile Store');
      await hide(ctx, true);
      await notify.email({ recipient: 'owner@example.com', template: 'merchant_notification', data: { title: 'Hi', body: 'There' }, workspaceId: ctx.wid });
      expect(lastSend().fromName).toBeUndefined();
    });
  });
});
