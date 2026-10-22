'use strict';

// What each visit was (TRAFFIC_DETAILS_ENABLED, analytics/traffic/visitorDetails.js)
// and the screens that read it: the merchant's Visitors section
// (/workspaces/:id/analytics/visitors/*) and the console's Store traffic
// (/admin/store-traffic/*) — a merchant sees their own store only and never
// an IP; visible time per page and product; the governorate from the IP's
// region, replaced by the order's; the funnel, campaigns and outcomes per governorate.

const { app, request, registerAndActivate, createWorkspace, createProductWithVariant, makePlatformUser, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const counters = require('../../src/modules/analytics/traffic/trafficCounters');
const suspicion = require('../../src/modules/analytics/traffic/suspicion');
const guard = require('../../src/modules/analytics/traffic/trafficGuard');
const ipHash = require('../../src/modules/analytics/traffic/ipHash');
const retention = require('../../src/modules/analytics/traffic/retention');

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SAVED = { details: { ...env.trafficDetails }, guard: { ...env.trafficGuard }, geo: env.analytics.geoHeaders, retention: env.analyticsRawRetentionDays };

let uniquePhone = 5000000000;
const nextPhone = () => `01${String(++uniquePhone).slice(-9)}`;
let seq = 0;
const pv = () => `pv-${Date.now().toString(36)}-${++seq}`;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function store(name = 'Visitors Store') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const base = `/api/v1/workspaces/${workspace.id}/analytics/visitors`;
  return {
    auth,
    workspace,
    H,
    get: (path, query = {}, headers = H) => request(app).get(`${base}${path}`).set(headers).query(query),
    post: (body, { ua = UA, geo } = {}) => {
      const req = request(app).post(`/api/v1/store/${workspace.id}/events`).set('User-Agent', ua);
      if (geo) for (const [k, v] of Object.entries(geo)) req.set(k, v);
      return req.send(body);
    },
    product: (name = 'Blue Mug') => createProductWithVariant(auth.accessToken, workspace.id, { price: 25000, stock: 50 }).then(async (r) => {
      await db.Product.update({ name }, { where: { id: r.product.id } });
      return r;
    }),
    order: async (variant, province) => {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set(H)
        .set('Idempotency-Key', `ord-${Math.random().toString(36).slice(2)}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: 'Buyer', phone: nextPhone() },
          shippingAddress: { country: 'EG', province, city: 'X', addressLine: '1 Visitor St' },
          paymentMethod: 'cod',
        });
      if (res.status !== 201) throw new Error(`order failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.order;
    },
  };
}

const CAIRO = { 'cf-ipcountry': 'EG', 'cf-region-code': 'C', 'cf-ipcity': 'Cairo' };

beforeEach(() => {
  env.trafficDetails.enabled = true;
  Object.assign(env.trafficGuard, SAVED.guard, { enabled: false });
  env.analytics.geoHeaders = ['cloudflare'];
  counters.reset();
  suspicion.reset();
  guard.reset();
  ipHash.reset();
});

afterAll(() => {
  Object.assign(env.trafficDetails, SAVED.details);
  Object.assign(env.trafficGuard, SAVED.guard);
  env.analytics.geoHeaders = SAVED.geo;
  env.analyticsRawRetentionDays = SAVED.retention;
});

describe('collection', () => {
  it('off: stores exactly what it always did, and drops visible-time reports', async () => {
    env.trafficDetails.enabled = false;
    const s = await store();
    const res = await s.post({
      visitorId: 'visitor-off-1',
      sessionId: 'session-off-1',
      attribution: { clickIds: { fbclid: 'abc' } },
      events: [{ name: 'page_view', path: '/', pageViewId: 'pvoff0001' }, { name: 'page_dwell', pageViewId: 'pvoff0001', dwellMs: 3000 }],
    });
    expect(res.body).toEqual({ accepted: 1 });
    const [event] = await db.AnalyticsEvent.findAll({ where: { workspaceId: s.workspace.id } });
    expect(event.eventName).toBe('page_view');
    expect(event.dedupeId).toBeNull();
    expect(event.clickIds).toEqual({ fbclid: 'abc' });
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: s.workspace.id } });
    expect(session.detailed).toBe(false);
  });

  it('on: the visit keeps its source, landing page, click ids as yes/no, and the IP region as an approximate governorate', async () => {
    const s = await store();
    await s.post(
      {
        visitorId: 'visitor-on-1',
        sessionId: 'session-on-1',
        attribution: { referrer: 'https://www.facebook.com/', landingPage: '/products/mug?utm_source=facebook', clickIds: { fbclid: 'IwAR-secret' } },
        events: [{ name: 'page_view', url: '/products/mug?utm_source=facebook&utm_medium=cpc&utm_campaign=Ramadan&utm_content=v1&utm_term=mug', referrer: 'https://www.facebook.com/' }],
      },
      { geo: CAIRO }
    );
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: s.workspace.id }, raw: true });
    expect(session).toMatchObject({
      detailed: true,
      source: 'facebook',
      medium: 'cpc',
      campaign: 'Ramadan',
      utmContent: 'v1',
      utmTerm: 'mug',
      referrerDomain: 'facebook.com',
      landingPath: '/products/mug',
      hasFbclid: true,
      hasGclid: false,
      country: 'EG',
      region: 'EG-C',
      governorate: 'cairo',
      governorateApprox: 'cairo',
      geoSource: 'ip_approx',
    });
    const [event] = await db.AnalyticsEvent.findAll({ where: { workspaceId: s.workspace.id }, raw: true });
    expect(event.clickIds).toEqual({ fbclid: true });
    expect(JSON.stringify(event)).not.toContain('IwAR-secret');
    expect(JSON.stringify(session)).not.toContain('IwAR-secret');
  });

  it('no region header: no governorate, nothing guessed', async () => {
    const s = await store();
    await s.post({ visitorId: 'visitor-nogeo', sessionId: 'session-nogeo', events: [{ name: 'page_view', path: '/' }] }, { geo: { 'cf-ipcountry': 'EG' } });
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: s.workspace.id }, raw: true });
    expect(session).toMatchObject({ country: 'EG', governorate: null, governorateApprox: null, geoSource: null });
  });

  it('visible time: the highest report of a page view wins, with its product; time past the page view is capped', async () => {
    const s = await store();
    const { product } = await s.product();
    const id = pv();
    await s.post({ visitorId: 'visitor-dwell', sessionId: 'session-dwell', events: [{ name: 'page_view', path: '/products/mug', pageViewId: id, occurredAt: ago(60000) }] });
    expect((await s.post({ visitorId: 'visitor-dwell', sessionId: 'session-dwell', events: [{ name: 'page_dwell', pageViewId: id, dwellMs: 12000, productId: product.id }] })).body).toEqual({
      accepted: 1,
    });
    await s.post({ visitorId: 'visitor-dwell', sessionId: 'session-dwell', events: [{ name: 'page_dwell', pageViewId: id, dwellMs: 8000 }] });
    let row = await db.AnalyticsEvent.findOne({ where: { workspaceId: s.workspace.id, dedupeId: `pv:${id}` } });
    expect(row.dwellMs).toBe(12000);
    expect(row.productId).toBe(product.id);
    // Ten minutes on a page viewed a minute ago: stored as at most the minute (+ tolerance).
    await s.post({ visitorId: 'visitor-dwell', sessionId: 'session-dwell', events: [{ name: 'page_dwell', pageViewId: id, dwellMs: 600000 }] });
    await row.reload();
    expect(row.dwellMs).toBeGreaterThanOrEqual(60000);
    expect(row.dwellMs).toBeLessThanOrEqual(60000 + 30000 + 5000);
    // Another session cannot write on this page view.
    await s.post({ visitorId: 'visitor-x', sessionId: 'session-x-1', events: [{ name: 'page_view', path: '/' }, { name: 'page_dwell', pageViewId: id, dwellMs: 99 }] });
    await row.reload();
    expect(row.dwellMs).toBeGreaterThanOrEqual(60000);
  });

  it('with the guard on, an impossible visible time flags the session and its events leave the numbers', async () => {
    env.trafficGuard.enabled = true;
    const s = await store();
    const id = pv();
    await s.post({ visitorId: 'visitor-imp', sessionId: 'session-imp', events: [{ name: 'page_view', path: '/', pageViewId: id }] });
    await s.post({ visitorId: 'visitor-imp', sessionId: 'session-imp', events: [{ name: 'page_dwell', pageViewId: id, dwellMs: 3 * 60 * 60 * 1000 }] });
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: s.workspace.id } });
    expect(session).toMatchObject({ isSuspicious: true, flagReason: 'impossible_dwell' });
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: s.workspace.id } })).toBe(0);
  });

  it("an order replaces every session's governorate with the order's and keeps the IP's; only the visit that bought is an order", async () => {
    const s = await store();
    const { variant } = await s.product();
    await s.post({ visitorId: 'visitor-buyer', sessionId: 'session-b1', events: [{ name: 'page_view', path: '/' }] }, { geo: CAIRO });
    await s.post({ visitorId: 'visitor-buyer', sessionId: 'session-b2', events: [{ name: 'page_view', path: '/c' }] }, { geo: CAIRO });
    const order = await s.order(variant, 'الجيزة (Giza)');
    await s.post({ visitorId: 'visitor-buyer', sessionId: 'session-b2', events: [{ name: 'purchase', orderId: order.id, dedupeId: `purchase:${order.id}` }] }, { geo: CAIRO });
    const sessions = await db.AnalyticsSession.findAll({ where: { workspaceId: s.workspace.id }, order: [['id', 'ASC']], raw: true });
    expect(sessions).toHaveLength(2);
    for (const row of sessions) expect(row).toMatchObject({ governorate: 'giza', governorateApprox: 'cairo', geoSource: 'order_address' });
    expect(sessions.map((r) => [r.id, r.ordered, r.lastOrderId])).toEqual([
      ['session-b1', false, null],
      ['session-b2', true, order.id],
    ]);
  });
});

describe("the merchant's Visitors section", () => {
  async function seeded() {
    const s = await store();
    const { product, variant } = await s.product('Red Scarf');
    const p1 = pv();
    const p2 = pv();
    // A visitor from Facebook in Cairo who buys…
    await s.post(
      {
        visitorId: 'visitor-a',
        sessionId: 'session-a',
        events: [
          { name: 'page_view', url: '/?utm_source=facebook&utm_campaign=eid', pageViewId: p1, occurredAt: ago(120000) },
          { name: 'page_view', path: '/products/scarf', pageViewId: p2, occurredAt: ago(90000) },
          { name: 'view_content', path: '/products/scarf', metadata: { contentIds: [product.id] }, occurredAt: ago(89000) },
          { name: 'add_to_cart', path: '/products/scarf', occurredAt: ago(60000) },
          { name: 'begin_checkout', path: '/checkout', occurredAt: ago(50000) },
          { name: 'page_dwell', pageViewId: p1, dwellMs: 20000 },
          { name: 'page_dwell', pageViewId: p2, dwellMs: 40000, productId: product.id },
        ],
      },
      { geo: CAIRO }
    );
    const order = await s.order(variant, 'القاهرة (Cairo)');
    await s.post({ visitorId: 'visitor-a', sessionId: 'session-a', events: [{ name: 'purchase', orderId: order.id, dedupeId: `purchase:${order.id}` }] }, { geo: CAIRO });
    // …and a direct visitor on a desktop with no region, who only looks.
    await s.post({ visitorId: 'visitor-b', sessionId: 'session-b', events: [{ name: 'page_view', path: '/', pageViewId: pv() }] }, { ua: DESKTOP });
    return { s, product, order };
  }

  it('summary: visits, visitors, funnel by unique visitors, conversion, sources, places, devices, pages and products with visible time', async () => {
    const { s, product } = await seeded();
    const res = await s.get('/summary', { range: '7d' });
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b).toMatchObject({ visits: 2, visitors: 2, pageViews: 3, orders: 1, conversionRate: 50 });
    expect(b.funnel).toEqual([
      { key: 'visit', visitors: 2, dropRate: null },
      { key: 'product', visitors: 1, dropRate: 50 },
      { key: 'cart', visitors: 1, dropRate: 0 },
      { key: 'checkout', visitors: 1, dropRate: 0 },
      { key: 'order', visitors: 1, dropRate: 0 },
    ]);
    expect(b.sources).toEqual(expect.arrayContaining([{ source: 'facebook', visits: 1, visitors: 1, conversionRate: 100 }, { source: 'direct', visits: 1, visitors: 1, conversionRate: 0 }]));
    expect(b.governorates).toEqual([{ governorate: 'cairo', visits: 1, fromOrders: 1, approximate: 0 }]);
    expect(b.devices).toEqual(expect.arrayContaining([{ device: 'mobile', visits: 1 }]));
    expect(b.pages.avgDwellMs).toBe(30000);
    expect(b.pages.topPages.find((p) => p.path === '/products/scarf')).toMatchObject({ views: 1, avgDwellMs: 40000 });
    expect(b.pages.topProducts).toEqual([{ productId: product.id, name: 'Red Scarf', views: 1, visits: 1, avgDwellMs: 40000, timedViews: 1 }]);
    expect(b.overCap).toEqual({ events: 0, pageViews: 0 });
  });

  it('filters narrow every number: country, governorate, device, source', async () => {
    const { s } = await seeded();
    expect((await s.get('/summary', { range: '7d', governorate: 'cairo' })).body).toMatchObject({ visits: 1, visitors: 1 });
    expect((await s.get('/summary', { range: '7d', source: 'direct' })).body).toMatchObject({ visits: 1, orders: 0 });
    expect((await s.get('/summary', { range: '7d', device: 'mobile' })).body.visits).toBe(1);
    expect((await s.get('/summary', { range: '7d', country: 'eg' })).body.visits).toBe(1);
    expect((await s.get('/summary', { governorate: 'atlantis' })).status).toBe(422);
  });

  it('sessions: paged and sorted, with an anonymous label and no IP; one visit in order with its time per page', async () => {
    const { s, product, order } = await seeded();
    const list = await s.get('/sessions', { range: '7d', pageSize: 1, sort: 'pages' });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    const [first] = list.body.sessions;
    expect(first).toMatchObject({ sessionId: 'session-a', pageViews: 2, dwellMs: 60000, governorate: 'cairo', geoSource: 'order_address', source: 'facebook', campaign: 'eid' });
    expect(first.visitor).toMatch(/^V-[0-9a-f]{8}$/);
    expect(first).not.toHaveProperty('ipHash');
    expect((await s.get('/sessions', { range: '7d', pageSize: 1, page: 2, sort: 'pages' })).body.sessions[0].sessionId).toBe('session-b');

    const one = await s.get('/sessions/session-a');
    expect(one.status).toBe(200);
    expect(one.body.events.map((e) => e.type)).toEqual(['page_view', 'page_view', 'view_product', 'add_to_cart', 'begin_checkout', 'order']);
    expect(one.body.events[1]).toMatchObject({ path: '/products/scarf', dwellMs: 40000, productId: product.id, productName: 'Red Scarf' });
    expect(one.body.events[5]).toMatchObject({ orderId: order.id, amount: Number(order.totalAmount) });
    expect(one.body.session.dwellMs).toBe(60000);
  });

  it('never shows an IP, raw or hashed, to a merchant', async () => {
    env.trafficGuard.enabled = true;
    const { s } = await seeded();
    const stored = await db.AnalyticsSession.findOne({ where: { workspaceId: s.workspace.id, id: 'session-a' } });
    expect(stored.ipHash).toMatch(/^[0-9a-f]{16}$/);
    const bodies = [
      (await s.get('/summary', { range: '7d' })).body,
      (await s.get('/sessions', { range: '7d' })).body,
      (await s.get('/sessions/session-a')).body,
      (await s.get('/campaigns', { range: '7d' })).body,
    ];
    for (const body of bodies) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(stored.ipHash);
      expect(text).not.toMatch(/ipHash|ip_hash|127\.0\.0\.1|::ffff/);
    }
  });

  it("a merchant sees their own store only: another store's visit is not found, its numbers are not mixed in, its URL is refused", async () => {
    const { s } = await seeded();
    const other = await store('Other Store');
    await other.post({ visitorId: 'visitor-other', sessionId: 'session-other', events: [{ name: 'page_view', path: '/' }] });

    expect((await s.get('/summary', { range: '7d' })).body.visits).toBe(2);
    expect((await other.get('/summary', { range: '7d' })).body.visits).toBe(1);
    // Store A's owner asking for B's visit through A's own URL: not found.
    expect((await s.get('/sessions/session-other')).status).toBe(404);
    // …and through B's URL: not a member of B.
    const viaOther = await request(app).get(`/api/v1/workspaces/${other.workspace.id}/analytics/visitors/summary`).set(s.H);
    expect([403, 404]).toContain(viaOther.status);
    expect((await other.get('/sessions', { range: '7d' })).body.sessions.map((r) => r.sessionId)).toEqual(['session-other']);
  });

  it('needs analytics.view: an order operator is refused', async () => {
    const { s } = await seeded();
    const operator = await addMemberWithRole(s.auth.accessToken, s.workspace.id, 'order_operator');
    const res = await s.get('/summary', {}, { Authorization: `Bearer ${operator.accessToken}` });
    expect(res.status).toBe(403);
  });

  it('a period is at most 31 days', async () => {
    const { s } = await seeded();
    const res = await s.get('/summary', { from: ago(40 * 24 * 3600 * 1000), to: new Date().toISOString() });
    expect(res.status).toBe(422);
  });

  it('campaigns: visits, carts, orders, revenue, conversion; spend and CPA only once spend is recorded', async () => {
    const { s, order } = await seeded();
    let res = await s.get('/campaigns', { range: '7d' });
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toEqual([
      {
        source: 'facebook',
        campaign: 'eid',
        visits: 1,
        visitors: 1,
        carts: 1,
        orders: 1,
        revenue: Number(order.totalAmount),
        currency: 'EGP',
        conversionRate: 100,
        spend: null,
        cpa: null,
      },
    ]);
    // The store's own date (the period is cut at its midnights), not UTC's.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    await db.AdSpendDaily.create({
      workspaceId: s.workspace.id,
      day: today,
      platform: 'meta',
      campaignName: 'EID',
      campaignKey: 'eid',
      spendAmount: 30000,
      currency: 'EGP',
    });
    res = await s.get('/campaigns', { range: '7d' });
    expect(res.body.campaigns[0]).toMatchObject({ spend: 30000, cpa: 30000 });
  });
});

describe('outcomes per governorate', () => {
  it('rates from finished orders only, once a governorate has 10; under way orders apart', async () => {
    const s = await store();
    const { variant } = await s.product();
    const cairo = [];
    for (let i = 0; i < 11; i += 1) cairo.push(await s.order(variant, 'القاهرة (Cairo)'));
    const giza = [await s.order(variant, 'Giza'), await s.order(variant, 'Giza')];
    // Cairo: 6 delivered, 3 returned, 2 refused on the call; Giza: 1 delivered, 1 still pending.
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: cairo.slice(0, 6).map((o) => o.id) } });
    await db.Order.update({ fulfillmentState: 'returned' }, { where: { id: cairo.slice(6, 9).map((o) => o.id) } });
    await db.Order.update({ confirmationState: 'rejected' }, { where: { id: cairo.slice(9, 11).map((o) => o.id) } });
    await db.Order.update({ fulfillmentState: 'fulfilled' }, { where: { id: giza[0].id } });

    const res = await s.get('/governorates');
    expect(res.status).toBe(200);
    expect(res.body.minOrders).toBe(10);
    const byCode = Object.fromEntries(res.body.governorates.map((g) => [g.governorate, g]));
    expect(byCode.cairo).toEqual({
      governorate: 'cairo',
      finished: 11,
      inProgress: 0,
      delivered: 6,
      returned: 3,
      cancelled: 2,
      enough: true,
      deliveryRate: 54.5,
      returnRate: 27.3,
      cancelRate: 18.2,
    });
    expect(byCode.giza).toMatchObject({ finished: 1, inProgress: 1, enough: false, deliveryRate: null, returnRate: null, cancelRate: null });
  });
});

describe("the console's Store traffic", () => {
  it('every store or one, with the store and the IP hash; a flagged visit shows its quarantined events', async () => {
    env.trafficGuard.enabled = true;
    const a = await store('Store A');
    const b = await store('Store B');
    await a.post({ visitorId: 'visitor-ca', sessionId: 'session-ca', events: [{ name: 'page_view', path: '/' }] }, { geo: CAIRO });
    await b.post({ visitorId: 'visitor-cb', sessionId: 'session-cb', events: [{ name: 'page_view', path: '/' }] });
    await b.post({ visitorId: 'visitor-bot', sessionId: 'session-bot', events: [{ name: 'page_view', path: '/x' }] });
    await b.post({ visitorId: 'visitor-bot', sessionId: 'session-bot', automation: true, events: [{ name: 'page_view', path: '/y' }] });

    const admin = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['workspaces.view'] }, { where: { id: admin.userId } });
    const all = await request(app).get('/api/v1/admin/store-traffic/sessions?range=7d').set(admin.H);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.sessions.map((r) => r.storeName).sort()).toEqual(['Store A', 'Store B']);
    expect(all.body.sessions[0].ipHash).toMatch(/^[0-9a-f]{16}$/);

    const onlyA = await request(app).get(`/api/v1/admin/store-traffic/summary?range=7d&workspaceId=${a.workspace.id}`).set(admin.H);
    expect(onlyA.body).toMatchObject({ visits: 1 });
    expect(onlyA.body.pages.topPages[0].path).toBe('/');
    const everyStore = await request(app).get('/api/v1/admin/store-traffic/summary?range=7d').set(admin.H);
    expect(everyStore.body).toMatchObject({ visits: 2, pages: null });

    const flagged = await request(app).get(`/api/v1/admin/store-traffic/sessions/${b.workspace.id}/session-bot`).set(admin.H);
    expect(flagged.status).toBe(200);
    expect(flagged.body.quarantined).toBe(true);
    expect(flagged.body.session.flagged).toBe('automation');
    expect(flagged.body.events.map((e) => e.path)).toEqual(['/x']);

    const noRights = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['overview.view'] }, { where: { id: noRights.userId } });
    expect((await request(app).get('/api/v1/admin/store-traffic/sessions').set(noRights.H)).status).toBe(403);
  });
});

describe('raw retention (ANALYTICS_RAW_RETENTION_DAYS)', () => {
  it('off by default; on, counts the old days into analytics_daily and then deletes them', async () => {
    const s = await store();
    await s.post({ visitorId: 'visitor-old', sessionId: 'session-old', events: [{ name: 'page_view', path: '/' }, { name: 'add_to_cart', path: '/' }] });
    await s.post({ visitorId: 'visitor-new', sessionId: 'session-new', events: [{ name: 'page_view', path: '/' }] });
    await db.sequelize.query("UPDATE analytics_events SET created_at = NOW() - interval '100 days' WHERE session_id = 'session-old'");
    await db.sequelize.query("UPDATE analytics_sessions SET created_at = NOW() - interval '100 days', last_seen_at = NOW() - interval '100 days' WHERE id = 'session-old'");

    env.analyticsRawRetentionDays = 0;
    expect(await retention.run()).toEqual({ enabled: false });
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: s.workspace.id } })).toBe(3);

    const result = await retention.run({ days: 90 });
    expect(result).toMatchObject({ enabled: true, stores: 1, events: 2, sessions: 1 });
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: s.workspace.id } })).toBe(1);
    const [daily] = await db.sequelize.query(
      "SELECT sum((metrics->>'visits')::int) AS visits, sum((metrics->>'add_to_cart')::int) AS carts FROM analytics_daily WHERE workspace_id = :w AND funnel_key = ''",
      { replacements: { w: s.workspace.id }, type: db.Sequelize.QueryTypes.SELECT }
    );
    expect(Number(daily.visits)).toBe(1);
    expect(Number(daily.carts)).toBe(1);
  });
});
