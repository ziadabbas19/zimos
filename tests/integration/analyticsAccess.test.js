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
} = require('../helpers/factories');
const db = require('../../src/db/models');
const { createStorefrontLimiter } = require('../../src/core/middleware/rateLimiters');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const { MAX_BODY_BYTES } = require('../../src/modules/analytics/eventsPublicRoutes');

const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';
const STAFF_ENDPOINTS = ['summary', 'overview', 'utm', 'funnels', 'web/stats', 'web/series', 'web/metrics?type=path', 'web/weekly', 'web/realtime'];

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
