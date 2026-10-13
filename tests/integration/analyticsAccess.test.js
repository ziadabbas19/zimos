'use strict';

// What the analytics port adds around the ported services: who may read the
// staff endpoints (analytics.view), the event ingest's body cap and its
// behaviour for a restricted store, the untrusted-by-default CDN geo headers,
// and the separate rate-limit buckets that keep beacons from ever using up a
// shopper's cart and checkout budget.

const express = require('express');
const {
  app,
  request,
  registerAndActivate,
  createWorkspace,
  addMemberWithRole,
  createProductWithVariant,
} = require('../helpers/factories');
const db = require('../../src/db/models');
const { createStorefrontLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const { MAX_BODY_BYTES } = require('../../src/modules/analytics/eventsPublicRoutes');

const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
const STAFF_ENDPOINTS = ['summary', 'funnels', 'web/stats', 'web/series', 'web/metrics?type=path', 'web/weekly', 'web/realtime'];

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Analytics Access');
  const events = (body, headers = {}) =>
    request(app).post(`/api/v1/store/${workspace.id}/events`).set('User-Agent', DESKTOP_UA).set(headers).send(body);
  const get = (token, path) =>
    request(app).get(`/api/v1/workspaces/${workspace.id}/analytics/${path}`).set({ Authorization: `Bearer ${token}` });
  return { auth, workspace, events, get };
}

const batch = (over = {}) => ({
  visitorId: 'visitor-access-1',
  sessionId: 'session-access-1',
  events: [{ name: 'page_view', url: '/' }],
  ...over,
});

describe('analytics — staff access (analytics.view)', () => {
  it('lets the owner, workspace managers and accountants read every endpoint', async () => {
    const ctx = await setup();
    const manager = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'workspace_manager', 'Mgr');
    const accountant = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'accountant', 'Acc');
    for (const token of [ctx.auth.accessToken, manager.accessToken, accountant.accessToken]) {
      for (const path of STAFF_ENDPOINTS) {
        const res = await ctx.get(token, path);
        expect([path, res.status]).toEqual([path, 200]);
      }
    }
  });

  it('refuses roles without analytics.view', async () => {
    const ctx = await setup();
    for (const roleKey of ['editor', 'order_operator', 'confirmation_agent']) {
      const member = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, roleKey, roleKey);
      for (const path of STAFF_ENDPOINTS) {
        const res = await ctx.get(member.accessToken, path);
        expect([roleKey, path, res.status]).toEqual([roleKey, path, 403]);
      }
    }
  });

  it("never serves another workspace's numbers", async () => {
    const ctx = await setup();
    const outsider = await registerAndActivate();
    const res = await ctx.get(outsider.accessToken, 'summary');
    expect([403, 404]).toContain(res.status);
  });
});

describe('analytics overview — top funnels', () => {
  it("never shows a funnel of another store, whatever funnel id an order of this store carries", async () => {
    const ctx = await setup();
    const H = { Authorization: `Bearer ${ctx.auth.accessToken}` };
    const { variant } = await createProductWithVariant(ctx.auth.accessToken, ctx.workspace.id, { price: 5000, stock: 5 });

    // Another store's funnel; this store's staff only learned its id.
    const other = await setup();
    const foreign = await request(app)
      .post(`/api/v1/workspaces/${other.workspace.id}/funnels`)
      .set({ Authorization: `Bearer ${other.auth.accessToken}` })
      .send({ name: 'VICTIM-ONLY-NAME' });
    expect(foreign.status).toBe(201);
    const own = await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/funnels`).set(H).send({ name: 'Own Funnel' });
    expect(own.status).toBe(201);

    const order = (funnelId) =>
      request(app)
        .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
        .set(H)
        .set('Idempotency-Key', `ov-${Math.random().toString(36).slice(2)}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: 'Overview Buyer', phone: '01055500011' },
          shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Overview St' },
          paymentMethod: 'cod',
          funnelId,
        });
    const withForeign = await order(foreign.body.funnel.id);
    expect(withForeign.status).toBe(201);
    // Whatever the order row kept of that id, the list is built from this store's funnels.
    await db.Order.update({ funnelId: foreign.body.funnel.id }, { where: { id: withForeign.body.order.id } });

    const res = await ctx.get(ctx.auth.accessToken, 'overview');
    expect(res.status).toBe(200);
    expect(res.body.overview.topFunnels).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('VICTIM-ONLY-NAME');

    // An order of one of its own funnels is listed as before.
    const withOwn = await order(own.body.funnel.id);
    expect(withOwn.status).toBe(201);
    await db.Order.update({ funnelId: own.body.funnel.id }, { where: { id: withOwn.body.order.id } });
    const again = await ctx.get(ctx.auth.accessToken, 'overview');
    expect(again.body.overview.topFunnels.map((f) => f.name)).toEqual(['Own Funnel']);
  });
});

describe('customer lists — phones for roles without customers.reveal_sensitive', () => {
  it('masks them in the contacts list, the segment preview and the dashboard search; the owner sees them', async () => {
    const ctx = await setup();
    await db.Customer.create({
      workspaceId: ctx.workspace.id,
      fullName: 'Mona Ali',
      phoneNormalized: '201012345665',
      phoneRaw: '01012345665',
    });
    const operator = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'order_operator', 'Operator');
    const base = `/api/v1/workspaces/${ctx.workspace.id}`;
    const as = (token) => ({
      contacts: () => request(app).get(`${base}/contacts`).set({ Authorization: `Bearer ${token}` }),
      search: () => request(app).get(`${base}/search?q=01012345665`).set({ Authorization: `Bearer ${token}` }),
    });

    const list = await as(operator.accessToken).contacts();
    expect(list.status).toBe(200);
    expect(list.body.contacts[0].phoneNormalized).toMatch(/\*/);
    expect(list.body.contacts[0].phoneRaw).toMatch(/\*/);
    expect(list.body.contacts[0].fullName).toBe('Mona Ali');

    const found = await as(operator.accessToken).search();
    expect(found.status).toBe(200);
    expect(found.body.customers[0].phone).toMatch(/\*/);

    const owner = as(ctx.auth.accessToken);
    expect((await owner.contacts()).body.contacts[0].phoneNormalized).toBe('201012345665');
    expect((await owner.search()).body.customers[0].phone).toBe('01012345665');

    // The preview of a segment shows a sample of the same rows.
    const manager = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'workspace_manager', 'Mgr');
    const preview = await request(app)
      .post(`${base}/contacts/segments/preview`)
      .set({ Authorization: `Bearer ${manager.accessToken}` })
      .send({ rules: {} });
    expect(preview.status).toBe(200);
    expect(preview.body.sample[0].phoneNormalized).toMatch(/\*/);
  });
});

describe('analytics — public event ingest', () => {
  it(`refuses a body over ${MAX_BODY_BYTES} bytes with 413 and stores nothing`, async () => {
    const ctx = await setup();
    const res = await ctx.events(batch({ events: [{ name: 'page_view', url: '/', title: 'x'.repeat(MAX_BODY_BYTES) }] }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });

  it('answers malformed JSON with 400, not a server error', async () => {
    const ctx = await setup();
    const res = await request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/events`)
      .set('Content-Type', 'application/json')
      .send('{"visitorId": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BODY');
  });

  it('leaves the rest of the API on its own, larger body limit', async () => {
    const ctx = await setup();
    // Same size that the events route refuses: accepted by the parser, then validated.
    const res = await request(app)
      .post(`/api/v1/store/${ctx.workspace.id}/cart`)
      .send({ padding: 'x'.repeat(MAX_BODY_BYTES) });
    expect(res.status).not.toBe(413);
  });

  it('answers 423 STORE_UNAVAILABLE for a suspended store and stores nothing', async () => {
    const ctx = await setup();
    await db.Workspace.update(
      { status: 'suspended', suspendedAt: new Date(), suspensionReason: 'Test' },
      { where: { id: ctx.workspace.id } }
    );
    const res = await ctx.events(batch());
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('STORE_UNAVAILABLE');
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);
  });

  it('ignores CDN geo headers unless that CDN is trusted (the default trusts none)', async () => {
    const ctx = await setup();
    const res = await ctx.events(batch(), {
      'cf-ipcountry': 'EG',
      'cf-region-code': 'C',
      'cf-ipcity': 'Cairo',
      'x-vercel-ip-country': 'US',
    });
    expect(res.status).toBe(202);
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: ctx.workspace.id }, raw: true });
    expect(session).toMatchObject({ country: null, region: null, city: null });
  });

  it('records no geo when there are no CDN headers at all', async () => {
    const { getLocation } = require('../../src/modules/analytics/clientDetect');
    const none = () => undefined;
    expect(getLocation(none, ['cloudflare', 'vercel', 'cloudfront'])).toEqual({ country: null, region: null, city: null });
    // Placeholder countries a CDN uses for "unknown" / Tor are not countries.
    const header = (v) => (name) => (name === 'cf-ipcountry' ? v : undefined);
    expect(getLocation(header('XX'), ['cloudflare']).country).toBeNull();
    expect(getLocation(header('T1'), ['cloudflare']).country).toBeNull();
    expect(getLocation(header('EG'), ['cloudflare'])).toEqual({ country: 'EG', region: null, city: null });
  });
});

describe('analytics — rate-limit buckets', () => {
  // Limiters are skipped app-wide under NODE_ENV=test, so this mounts a fresh
  // storefront limiter with small limits on a bare app (as storefrontRateLimit.test.js).
  function buildApp() {
    const bare = express();
    bare.set('trust proxy', 1);
    bare.use('/store', createStorefrontLimiter({ windowMs: 60000, visitorMax: 3, ipMax: 6, serverMax: 10 }));
    bare.post('/store/:workspaceId/events', (req, res) => res.status(202).json({ key: req.storefrontClient.visitorKey }));
    bare.post('/store/:workspaceId/checkout-sessions', (req, res) => res.json({ key: req.storefrontClient.visitorKey }));
    bare.use(errorHandler);
    return bare;
  }

  it('counts beacons apart from the shopper\'s other calls, with the same limits', async () => {
    const bare = buildApp();
    const from = (path) => request(bare).post(`/store/ws/${path}`).set('X-Forwarded-For', '203.0.113.7').send({});

    const beacons = [];
    for (let i = 0; i < 4; i += 1) beacons.push((await from('events')).status);
    // Beacons are limited like everything else under /store ...
    expect(beacons).toEqual([202, 202, 202, 429]);

    // ... but the same shopper's checkout calls still have their whole budget.
    const checkout = await from('checkout-sessions');
    expect(checkout.status).toBe(200);
    expect(checkout.body.key).toBe('ip:203.0.113.7');
    expect((await from('events')).status).toBe(429);
  });
});
