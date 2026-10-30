'use strict';

// Storefront event ingest (POST /store/:workspaceId/events) and the traffic
// block of GET /analytics/summary. Ported from the zimos-additions branch.

const { app, request, registerAndActivate, createWorkspace, createProductWithVariant } = require('../helpers/factories');
const db = require('../../src/db/models');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

let uniquePhone = 3000000000;
const nextPhone = () => `01${String(++uniquePhone).slice(-9)}`;

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Acme Traffic');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  return {
    auth,
    workspace,
    H,
    post: (body, ua = DESKTOP_UA, wid = workspace.id) =>
      request(app).post(`/api/v1/store/${wid}/events`).set('User-Agent', ua).send(body),
    summary: (q = {}) => request(app).get(`/api/v1/workspaces/${workspace.id}/analytics/summary`).set(H).query(q),
    placeOrder: async () => {
      const { variant } = await createProductWithVariant(auth.accessToken, workspace.id, { price: 12000, stock: 50 });
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set(H)
        .set('Idempotency-Key', `ord-${Math.random().toString(36).slice(2)}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: 'Buyer', phone: nextPhone() },
          shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Traffic St' },
          paymentMethod: 'cod',
        });
      if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.order;
    },
  };
}

const batch = (over = {}) => ({
  visitorId: 'visitor-0001',
  sessionId: 'session-0001',
  events: [{ name: 'page_view', path: '/' }],
  ...over,
});

describe('POST /store/:workspaceId/events', () => {
  it('accepts a batch and stores device + attribution on every row', async () => {
    const ctx = await setup();
    const res = await ctx.post(
      batch({
        attribution: { source: 'facebook', medium: 'cpc', campaign: 'launch', referrer: 'https://fb.com/', landingPage: '/?utm_source=facebook', clickIds: { fbclid: 'abc' } },
        events: [
          { name: 'page_view', path: '/', metadata: { title: 'Home' } },
          { name: 'view_content', path: '/products/thing', websiteId: '11111111-1111-4111-8111-111111111111' },
        ],
      }),
      MOBILE_UA
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 2 });

    const rows = await db.AnalyticsEvent.findAll({ where: { workspaceId: ctx.workspace.id }, order: [['eventName', 'ASC']] });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({
        visitorId: 'visitor-0001',
        sessionId: 'session-0001',
        source: 'facebook',
        medium: 'cpc',
        campaign: 'launch',
        referrer: 'https://fb.com/',
        landingPage: '/?utm_source=facebook',
        clickIds: { fbclid: 'abc' },
      });
      expect(r.metadata.device).toBe('mobile');
    }
    expect(rows[0].eventName).toBe('page_view');
    expect(rows[0].metadata).toEqual({ device: 'mobile', path: '/', title: 'Home' });
    // An unknown website reference is nulled rather than failing the batch.
    expect(rows[1].websiteId).toBeNull();
  });

  it("takes a page's own utm tags as a set, rather than mixing them with the session's", async () => {
    const ctx = await setup();
    await ctx.post(
      batch({
        // The visitor arrived earlier from facebook; this page carries its own tags.
        attribution: { source: 'facebook', medium: 'cpc', campaign: 'launch' },
        events: [
          { name: 'page_view', url: '/sale?utm_source=newsletter&utm_campaign=eid' },
          { name: 'page_view', url: '/about' },
        ],
      })
    );

    const rows = await db.AnalyticsEvent.findAll({ where: { workspaceId: ctx.workspace.id }, order: [['urlPath', 'ASC']] });
    // No tags of its own: the session's attribution stands.
    expect(rows[0]).toMatchObject({ urlPath: '/about', source: 'facebook', medium: 'cpc', campaign: 'launch' });
    // Its own tags win outright — no facebook/cpc glued to this campaign.
    expect(rows[1]).toMatchObject({ urlPath: '/sale', source: 'newsletter', campaign: 'eid' });
    expect(rows[1].medium).toBeNull();
  });

  it('drops repeated dedupeIds silently (counted as accepted, stored once)', async () => {
    const ctx = await setup();
    const body = batch({ events: [{ name: 'add_to_cart', dedupeId: 'atc-1' }] });
    expect((await ctx.post(body)).body).toEqual({ accepted: 1 });
    expect((await ctx.post(body)).body).toEqual({ accepted: 1 });
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: ctx.workspace.id } })).toBe(1);
  });

  it('drops a purchase for a foreign order and uses the order total for a real one', async () => {
    const ctx = await setup();
    const other = await setup();
    const foreign = await other.placeOrder();
    const own = await ctx.placeOrder();

    const res = await ctx.post(
      batch({
        events: [
          { name: 'purchase', orderId: foreign.id, revenueAmount: 999 },
          { name: 'purchase', orderId: own.id, revenueAmount: 1 },
        ],
      })
    );
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1 });

    const rows = await db.AnalyticsEvent.findAll({ where: { workspaceId: ctx.workspace.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(own.id);
    expect(Number(rows[0].revenueAmount)).toBe(Number(own.totalAmount));
    expect(Number(rows[0].revenueAmount)).toBeGreaterThan(1);
  });

  it('returns 404 for an unknown workspace', async () => {
    const ctx = await setup();
    const res = await ctx.post(batch(), DESKTOP_UA, '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('rejects an empty events array', async () => {
    const ctx = await setup();
    const res = await ctx.post(batch({ events: [] }));
    expect(res.status).toBe(422);
    expect(await db.AnalyticsEvent.count()).toBe(0);
  });
});

describe('GET /analytics/summary traffic', () => {
  it('returns zeros for a workspace with no events', async () => {
    const ctx = await setup();
    const res = await ctx.summary();
    expect(res.status).toBe(200);
    expect(res.body.summary.traffic).toEqual({
      sessions: 0,
      visitors: 0,
      pageViews: 0,
      productViews: 0,
      addToCart: 0,
      checkouts: 0,
      purchases: 0,
      conversionRate: null,
      addToCartRate: null,
      checkoutRate: null,
      byDevice: [],
      bySource: [],
      topPages: [],
    });
    expect(res.body.summary.series.every((d) => d.sessions === 0)).toBe(true);
  });

  it('aggregates sessions, funnel steps, devices, sources and pages', async () => {
    const ctx = await setup();
    const order = await ctx.placeOrder();

    // Mobile shopper from facebook: browses, adds to cart, checks out, buys.
    const mobile = await ctx.post(
      {
        visitorId: 'visitor-mobile',
        sessionId: 'session-mobile',
        attribution: { source: 'facebook', medium: 'cpc' },
        events: [
          { name: 'page_view', path: '/' },
          { name: 'view_content', path: '/products/thing' },
          { name: 'add_to_cart' },
          { name: 'begin_checkout', path: '/checkout' },
          { name: 'purchase', orderId: order.id },
        ],
      },
      MOBILE_UA
    );
    expect(mobile.status).toBe(202);

    // Desktop direct visitor: one page view.
    const desktop = await ctx.post(
      { visitorId: 'visitor-desktop', sessionId: 'session-desktop', events: [{ name: 'page_view', path: '/' }] },
      DESKTOP_UA
    );
    expect(desktop.status).toBe(202);

    const res = await ctx.summary();
    expect(res.status).toBe(200);
    const { traffic, series, orders } = res.body.summary;
    expect(orders.placed).toBe(1);
    expect(traffic).toMatchObject({
      sessions: 2,
      visitors: 2,
      pageViews: 2,
      productViews: 1,
      addToCart: 1,
      checkouts: 1,
      purchases: 1,
      conversionRate: 50,
      addToCartRate: 50,
      checkoutRate: 50,
    });
    expect(traffic.byDevice).toEqual(expect.arrayContaining([{ device: 'mobile', sessions: 1 }, { device: 'desktop', sessions: 1 }]));
    expect(traffic.byDevice).toHaveLength(2);
    expect(traffic.bySource).toEqual(
      expect.arrayContaining([
        { source: 'facebook', medium: 'cpc', sessions: 1, orders: 1 },
        { source: 'direct', medium: null, sessions: 1, orders: 0 },
      ])
    );
    expect(traffic.bySource).toHaveLength(2);
    expect(traffic.topPages).toEqual([{ path: '/', views: 2 }]);

    const today = series.reduce((a, b) => (a.sessions >= b.sessions ? a : b));
    expect(today.sessions).toBe(2);
    expect(series.reduce((n, d) => n + d.sessions, 0)).toBe(2);
  });

  it('excludes events outside the range', async () => {
    const ctx = await setup();
    await ctx.post(batch());
    const res = await ctx.summary({ from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.summary.traffic.sessions).toBe(0);
  });

  it("files a session under its first event (the id breaking a tie in time), and counts each step once a session", async () => {
    const ctx = await setup();
    const at = (iso) => new Date(iso);
    const row = (over) => ({ workspaceId: ctx.workspace.id, visitorId: 'visitor-a', eventName: 'page_view', ...over });
    await db.AnalyticsEvent.bulkCreate([
      // Session A: two events at its very start; the smaller id is the first.
      row({ id: '00000000-0000-4000-8000-0000000000a2', sessionId: 'sess-a', source: 'google', metadata: { device: 'desktop', path: '/x' }, createdAt: at('2026-10-20T10:00:00.000Z') }),
      row({ id: '00000000-0000-4000-8000-0000000000a1', sessionId: 'sess-a', source: 'tiktok', medium: 'social', metadata: { device: 'mobile', path: '/' }, createdAt: at('2026-10-20T10:00:00.000Z') }),
      row({ id: '00000000-0000-4000-8000-0000000000a0', sessionId: 'sess-a', eventName: 'add_to_cart', source: 'facebook', metadata: { device: 'tablet' }, createdAt: at('2026-10-20T10:05:00.000Z') }),
      row({ id: '00000000-0000-4000-8000-0000000000a3', sessionId: 'sess-a', eventName: 'add_to_cart', createdAt: at('2026-10-20T10:06:00.000Z') }),
      // Session B (no session id: the visitor is the session), from a device the summary does not name.
      row({ id: '00000000-0000-4000-8000-0000000000b1', visitorId: 'visitor-b', source: '', metadata: { device: 'tv', path: '/' }, createdAt: at('2026-10-21T09:00:00.000Z') }),
      row({ id: '00000000-0000-4000-8000-0000000000b2', visitorId: 'visitor-b', eventName: 'begin_checkout', createdAt: at('2026-10-21T09:01:00.000Z') }),
      // Session C, the same visitor as A.
      row({ id: '00000000-0000-4000-8000-0000000000c1', sessionId: 'sess-c', source: 'google', metadata: { device: 'mobile', path: '/x' }, createdAt: at('2026-10-22T12:00:00.000Z') }),
    ]);

    const res = await ctx.summary({ from: '2026-10-15T00:00:00.000Z', to: '2026-10-25T00:00:00.000Z' });
    expect(res.status).toBe(200);
    const { traffic, series } = res.body.summary;
    expect(traffic).toMatchObject({ sessions: 3, visitors: 2, pageViews: 4, addToCart: 1, checkouts: 1, purchases: 0 });
    expect(traffic.byDevice).toEqual([
      { device: 'mobile', sessions: 2 },
      { device: 'unknown', sessions: 1 },
    ]);
    expect(traffic.bySource).toEqual([
      { source: 'direct', medium: null, sessions: 1, orders: 0 },
      { source: 'google', medium: null, sessions: 1, orders: 0 },
      { source: 'tiktok', medium: 'social', sessions: 1, orders: 0 },
    ]);
    expect(traffic.topPages).toEqual([
      { path: '/', views: 2 },
      { path: '/x', views: 2 },
    ]);
    const sessionsOn = (date) => series.find((d) => d.date === date)?.sessions;
    expect([sessionsOn('2026-10-20'), sessionsOn('2026-10-21'), sessionsOn('2026-10-22')]).toEqual([1, 1, 1]);
  });
});
