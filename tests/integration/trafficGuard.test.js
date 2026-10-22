'use strict';

// The events guard on POST /store/:workspaceId/events (analytics/traffic,
// TRAFFIC_GUARD_ENABLED): bots counted not stored, the per-minute limits,
// duplicates, sessions faster than a person, automation, the Origin check and
// the daily cap — and that with the flag off nothing of it happens.

const { app, request, registerAndActivate, createWorkspace, createProductWithVariant, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { LIMITS } = require('../../src/modules/analytics/traffic/guardConfig');
const counters = require('../../src/modules/analytics/traffic/trafficCounters');
const suspicion = require('../../src/modules/analytics/traffic/suspicion');
const guard = require('../../src/modules/analytics/traffic/trafficGuard');
const originCheck = require('../../src/modules/analytics/traffic/originCheck');
const ipHash = require('../../src/modules/analytics/traffic/ipHash');
const purge = require('../../src/modules/analytics/traffic/purge');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const SAVED = { ...env.trafficGuard };
const SAVED_LIMITS = { ...LIMITS };

let uniquePhone = 4000000000;
const nextPhone = () => `01${String(++uniquePhone).slice(-9)}`;

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Guarded Store');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const origin = `https://${workspace.slug}.${env.platformRootDomain}`;
  return {
    auth,
    workspace,
    H,
    origin,
    post: (body, { ua = DESKTOP_UA, from = origin, ip } = {}) => {
      const req = request(app).post(`/api/v1/store/${workspace.id}/events`).set('User-Agent', ua);
      if (from) req.set('Origin', from);
      if (ip) req.set('X-Forwarded-For', ip);
      return req.send(body);
    },
    placeOrder: async () => {
      const { variant } = await createProductWithVariant(auth.accessToken, workspace.id, { price: 12000, stock: 50 });
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspace.id}/orders`)
        .set(H)
        .set('Idempotency-Key', `ord-${Math.random().toString(36).slice(2)}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: 'Buyer', phone: nextPhone() },
          shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Guard St' },
          paymentMethod: 'cod',
        });
      if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.order;
    },
  };
}

let seq = 0;
const views = (n, prefix = '/p') => Array.from({ length: n }, () => ({ name: 'page_view', path: `${prefix}/${++seq}` }));
const batch = (over = {}) => ({ visitorId: 'visitor-guard-1', sessionId: 'session-guard-1', events: views(1), ...over });

const storedEvents = (workspaceId) => db.AnalyticsEvent.count({ where: { workspaceId } });
const filterRows = async () => {
  await counters.flush();
  return db.TrafficFilterDay.findAll({ raw: true });
};
const sumOf = (rows, where) => rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).reduce((n, r) => n + Number(r.count), 0);

beforeEach(() => {
  Object.assign(env.trafficGuard, SAVED, { enabled: true, originCheck: 'off' });
  Object.assign(LIMITS, SAVED_LIMITS);
  counters.reset();
  suspicion.reset();
  guard.reset();
  originCheck.forget();
  ipHash.reset();
});

afterAll(() => {
  Object.assign(env.trafficGuard, SAVED);
  Object.assign(LIMITS, SAVED_LIMITS);
});

describe('events guard off', () => {
  it('changes nothing: a curl client is stored, no limits, nothing counted', async () => {
    env.trafficGuard.enabled = false;
    const ctx = await setup();
    // isbot has always treated curl as a bot: still answered as one, nothing stored.
    const curl = await ctx.post(batch(), { ua: 'curl/8.4.0' });
    expect(curl.status).toBe(202);
    expect(curl.body).toEqual({ accepted: 0, bot: true });
    const res = await ctx.post(batch({ events: [{ name: 'page_view', path: '/same' }, { name: 'page_view', path: '/same' }] }), { from: null });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 2 });
    expect(await storedEvents(ctx.workspace.id)).toBe(2);
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: ctx.workspace.id } });
    expect(session.ipHash).toBeNull();
    expect(await filterRows()).toEqual([]);
  });
});

describe('events guard on', () => {
  it('a known bot is answered as before and counted by family, never stored', async () => {
    const ctx = await setup();
    const google = await ctx.post(batch(), { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
    expect(google.status).toBe(202);
    expect(google.body).toEqual({ accepted: 0, bot: true });
    await ctx.post(batch({ events: views(3) }), { ua: 'python-requests/2.31.0' });
    await ctx.post(batch(), { ua: '' });
    expect(await storedEvents(ctx.workspace.id)).toBe(0);
    expect(await db.AnalyticsSession.count()).toBe(0);

    const rows = await filterRows();
    expect(sumOf(rows, { kind: 'bot', reason: 'good_bot', label: 'search:googlebot' })).toBe(1);
    expect(sumOf(rows, { kind: 'bot', reason: 'bad_bot', label: 'tool:python' })).toBe(3);
    expect(sumOf(rows, { kind: 'bot', reason: 'bad_bot', label: 'tool:empty' })).toBe(1);
    expect(rows.every((r) => r.workspaceId === ctx.workspace.id)).toBe(true);
  });

  it('stores a person with the IP only as a hash', async () => {
    const ctx = await setup();
    const res = await ctx.post(batch());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: 1 });
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: ctx.workspace.id }, raw: true });
    expect(session.ipHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(session)).not.toMatch(/127\.0\.0\.1|::ffff/);
    expect(await db.TrafficSalt.count()).toBe(1);
  });

  it('a body the schema refuses is counted and still answered 422', async () => {
    const ctx = await setup();
    const res = await ctx.post({ visitorId: 'x', events: [] });
    expect(res.status).toBe(422);
    expect(sumOf(await filterRows(), { kind: 'rejected', reason: 'invalid_body' })).toBe(1);
  });

  it('more than a visitor may send in a minute is refused with 429 and not stored', async () => {
    LIMITS.EVENTS_PER_VISITOR_MINUTE = 5;
    const ctx = await setup();
    expect((await ctx.post(batch({ events: views(4) }))).status).toBe(202);
    const refused = await ctx.post(batch({ events: views(2) }));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(await storedEvents(ctx.workspace.id)).toBe(4);
    // Another visitor on the same connection still gets through.
    expect((await ctx.post(batch({ visitorId: 'visitor-guard-2', sessionId: 'session-guard-2', events: views(2) }))).status).toBe(202);
    expect(sumOf(await filterRows(), { kind: 'rejected', reason: 'rate_visitor' })).toBe(2);
  });

  it('limits per IP and per store too; the IP is labelled by its hash', async () => {
    LIMITS.EVENTS_PER_IP_MINUTE = 3;
    const ctx = await setup();
    expect((await ctx.post(batch({ events: views(3) }))).status).toBe(202);
    expect((await ctx.post(batch({ visitorId: 'visitor-ip-2', sessionId: 'session-ip-2' }))).status).toBe(429);
    const ipRows = (await filterRows()).filter((r) => r.reason === 'rate_ip');
    expect(ipRows).toHaveLength(1);
    expect(ipRows[0].label).toMatch(/^[0-9a-f]{16}$/);

    LIMITS.EVENTS_PER_IP_MINUTE = SAVED_LIMITS.EVENTS_PER_IP_MINUTE;
    LIMITS.EVENTS_PER_STORE_MINUTE = 4;
    guard.reset();
    expect((await ctx.post(batch({ events: views(4) }))).status).toBe(202);
    expect((await ctx.post(batch({ visitorId: 'visitor-s-2', sessionId: 'session-s-2' }))).status).toBe(429);
    expect(sumOf(await filterRows(), { kind: 'rejected', reason: 'rate_store' })).toBe(1);
  });

  it('the same event on the same page within a second counts once', async () => {
    const ctx = await setup();
    const at = new Date().toISOString();
    const res = await ctx.post(
      batch({
        events: [
          { name: 'page_view', path: '/dup', occurredAt: at },
          { name: 'page_view', path: '/dup', occurredAt: at },
          { name: 'add_to_cart', path: '/dup', occurredAt: at },
        ],
      })
    );
    expect(res.body).toEqual({ accepted: 2 });
    // A replay of the whole batch adds nothing.
    expect((await ctx.post(batch({ events: [{ name: 'page_view', path: '/dup', occurredAt: at }] }))).body).toEqual({ accepted: 0 });
    expect(await storedEvents(ctx.workspace.id)).toBe(2);
    expect(sumOf(await filterRows(), { kind: 'rejected', reason: 'duplicate' })).toBe(2);
  });

  it('a visitor past 50 pages a minute is flagged: its events leave the numbers and later ones are not stored', async () => {
    const ctx = await setup();
    expect((await ctx.post(batch({ events: views(20) }))).body).toEqual({ accepted: 20 });
    expect((await ctx.post(batch({ events: views(20) }))).body).toEqual({ accepted: 20 });
    expect(await storedEvents(ctx.workspace.id)).toBe(40);
    const third = await ctx.post(batch({ events: views(20) }));
    expect(third.status).toBe(202);
    expect(third.body).toEqual({ accepted: 0 });

    expect(await storedEvents(ctx.workspace.id)).toBe(0);
    expect(await db.AnalyticsQuarantineEvent.count({ where: { workspaceId: ctx.workspace.id, reason: 'too_fast' } })).toBe(40);
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: ctx.workspace.id, id: 'session-guard-1' } });
    expect(session).toMatchObject({ isSuspicious: true, isBot: false, flagReason: 'too_fast', excludedEvents: 60 });

    await ctx.post(batch({ events: views(2) }));
    expect(await storedEvents(ctx.workspace.id)).toBe(0);
    await session.reload();
    expect(session.excludedEvents).toBe(62);
    const rows = await filterRows();
    expect(sumOf(rows, { kind: 'suspicious', reason: 'too_fast' })).toBe(62);

    // The web analytics no longer see the session.
    const stats = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/analytics/web/stats`).set(ctx.H);
    expect(stats.status).toBe(200);
    expect(stats.body.pageviews).toBe(0);
  });

  it('a session with a real order is never flagged', async () => {
    const ctx = await setup();
    const order = await ctx.placeOrder();
    await ctx.post(batch({ events: [{ name: 'purchase', orderId: order.id, dedupeId: `purchase:${order.id}` }] }));
    // 60 pages in a minute: past the limit, but the session bought.
    await ctx.post(batch({ events: views(20) }));
    await ctx.post(batch({ events: views(20) }));
    await ctx.post(batch({ events: views(20) }));
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: ctx.workspace.id, id: 'session-guard-1' } });
    expect(session.isSuspicious).toBe(false);
    expect(await storedEvents(ctx.workspace.id)).toBe(61);
  });

  it('a browser driven by automation is marked is_bot and stores nothing', async () => {
    const ctx = await setup();
    const res = await ctx.post(batch({ automation: true, events: views(3) }));
    expect(res.status).toBe(202);
    expect(await storedEvents(ctx.workspace.id)).toBe(0);
    const session = await db.AnalyticsSession.findOne({ where: { workspaceId: ctx.workspace.id } });
    expect(session).toMatchObject({ isBot: true, isSuspicious: false, flagReason: 'automation', excludedEvents: 3 });
    expect(sumOf(await filterRows(), { kind: 'bot', reason: 'automation' })).toBe(3);

    // A session that turns automated later loses what it had stored.
    await ctx.post(batch({ visitorId: 'visitor-later', sessionId: 'session-later', events: views(2) }));
    await ctx.post(batch({ visitorId: 'visitor-later', sessionId: 'session-later', automation: true, events: views(1) }));
    expect(await db.AnalyticsEvent.count({ where: { workspaceId: ctx.workspace.id, sessionId: 'session-later' } })).toBe(0);
    expect(await db.AnalyticsQuarantineEvent.count({ where: { sessionId: 'session-later', reason: 'automation' } })).toBe(2);
  });

  it('origin check: report counts a foreign page and stores; enforce refuses it with 403', async () => {
    const ctx = await setup();
    env.trafficGuard.originCheck = 'report';
    expect((await ctx.post(batch(), { from: 'https://evil.example' })).status).toBe(202);
    expect(await storedEvents(ctx.workspace.id)).toBe(1);

    env.trafficGuard.originCheck = 'enforce';
    const refused = await ctx.post(batch({ events: views(2) }), { from: 'https://evil.example' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect((await ctx.post(batch(), { from: null })).status).toBe(403);
    expect((await ctx.post(batch())).status).toBe(202);
    // A verified custom domain of the store is its own page.
    const website = await db.Website.create({ workspaceId: ctx.workspace.id, name: 'Guarded', subdomain: `guarded-${ctx.workspace.slug}` });
    await db.Domain.create({ workspaceId: ctx.workspace.id, websiteId: website.id, hostname: 'shop.example.org', status: 'verified', verificationToken: 'tok-guard' });
    originCheck.forget();
    expect((await ctx.post(batch({ events: views(1) }), { from: 'https://shop.example.org' })).status).toBe(202);
    expect(await storedEvents(ctx.workspace.id)).toBe(3);

    const rows = await filterRows();
    expect(sumOf(rows, { kind: 'rejected', reason: 'origin_mismatch_seen', label: 'evil.example' })).toBe(1);
    expect(sumOf(rows, { kind: 'rejected', reason: 'origin_mismatch', label: 'evil.example' })).toBe(2);
    expect(sumOf(rows, { kind: 'rejected', reason: 'origin_missing' })).toBe(1);
  });

  it('past the daily cap events are counted, not stored, the console is told once, and a real order still lands', async () => {
    env.trafficGuard.storeDailyCap = 5;
    const ctx = await setup();
    expect((await ctx.post(batch({ events: views(4) }))).body).toEqual({ accepted: 4 });
    expect((await ctx.post(batch({ events: views(3) }))).body).toEqual({ accepted: 1 });
    expect((await ctx.post(batch({ events: views(2) }))).body).toEqual({ accepted: 0 });
    const order = await ctx.placeOrder();
    expect((await ctx.post(batch({ events: [{ name: 'purchase', orderId: order.id, dedupeId: `purchase:${order.id}` }] }))).body).toEqual({ accepted: 1 });
    expect(await storedEvents(ctx.workspace.id)).toBe(6);

    await counters.flush();
    const day = await db.TrafficStoreDay.findOne({ where: { workspaceId: ctx.workspace.id }, raw: true });
    expect(Number(day.storedEvents)).toBe(6);
    expect(Number(day.overflowEvents)).toBe(4);
    expect(Number(day.overflowPageViews)).toBe(4);
    expect(day.capReachedAt).not.toBeNull();
    // platform_notifications has no model, so the per-test truncate leaves other tests' rows: this store's only.
    const notes = await db.sequelize.query("SELECT workspace_id, dedupe_key FROM platform_notifications WHERE type = 'traffic_cap' AND workspace_id = :ws", {
      replacements: { ws: ctx.workspace.id },
      type: db.Sequelize.QueryTypes.SELECT,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].workspace_id).toBe(ctx.workspace.id);
    expect(sumOf(await filterRows(), { kind: 'capped', reason: 'daily_cap' })).toBe(4);

    // The console's notification is for whoever can see stores.
    const admin = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['overview.view', 'workspaces.view'] }, { where: { id: admin.userId } });
    const list = await request(app).get('/api/v1/admin/notifications').set(admin.H);
    expect(list.body.notifications.map((n) => n.type)).toContain('traffic_cap');
  });

  it('the console shows what was kept out by kind, source, country and store, to workspaces.view only', async () => {
    const ctx = await setup();
    await ctx.post(batch({ events: views(2) }), { ua: 'curl/8.4.0' });
    await ctx.post(batch({ events: views(20) }));
    await ctx.post(batch({ events: views(20) }));
    await ctx.post(batch({ events: views(20) }));
    await counters.flush();

    const admin = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['workspaces.view'] }, { where: { id: admin.userId } });
    const res = await request(app).get('/api/v1/admin/store-traffic/protection?range=today').set(admin.H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, originCheck: 'off', range: 'today' });
    expect(res.body.totals).toEqual({ bot: 2, rejected: 0, suspicious: 60, capped: 0 });
    expect(res.body.bySource).toEqual([{ kind: 'bot', reason: 'bad_bot', label: 'tool:curl', count: 2 }]);
    expect(res.body.byStore[0]).toMatchObject({ workspaceId: ctx.workspace.id, bot: 2, suspicious: 60 });
    expect(res.body.flaggedSessions).toHaveLength(1);
    expect(res.body.flaggedSessions[0]).toMatchObject({ sessionId: 'session-guard-1', reason: 'too_fast', excludedEvents: 60 });
    expect(res.body.flaggedSessions[0].ipHash).toMatch(/^[0-9a-f]{16}$/);

    const other = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['overview.view'] }, { where: { id: other.userId } });
    expect((await request(app).get('/api/v1/admin/store-traffic/protection').set(other.H)).status).toBe(403);
  });

  it('a flush adds to the same row, and the purge keeps only recent days', async () => {
    const ctx = await setup();
    await ctx.post(batch(), { ua: 'curl/8.4.0' });
    await counters.flush();
    await ctx.post(batch(), { ua: 'curl/8.4.0' });
    const rows = await filterRows();
    expect(rows.filter((r) => r.label === 'tool:curl')).toHaveLength(1);
    expect(sumOf(rows, { label: 'tool:curl' })).toBe(2);

    await db.sequelize.query("UPDATE traffic_filter_days SET day = (now() AT TIME ZONE 'UTC')::date - 31");
    await db.sequelize.query("INSERT INTO traffic_salts (day, salt, created_at) VALUES ((now() AT TIME ZONE 'UTC')::date - 3, 'old', NOW())");
    const result = await purge.run();
    expect(result.filterDays).toBe(1);
    expect(result.salts).toBe(1);
    expect(await db.TrafficFilterDay.count()).toBe(0);
  });
});
