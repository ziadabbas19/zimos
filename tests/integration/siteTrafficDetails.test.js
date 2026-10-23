'use strict';

// zimos.co visits with the same detail as a store's (SITE_TRAFFIC_DETAILS_ENABLED):
// the beacon keeps the browser, the governorate and the sign-up link kind;
// bots and refused requests are counted per day (scope site), never stored;
// and the console's detailed Site visits read it all — off, nothing changes.

const express = require('express');
const { QueryTypes } = require('sequelize');
const { app, request, uniqueEmail, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const counters = require('../../src/modules/analytics/traffic/trafficCounters');
const ipHash = require('../../src/modules/analytics/traffic/ipHash');
const { createSiteEventsRouter } = require('../../src/modules/siteAnalytics/siteEventsRoutes');
const { createIpMinuteLimiter } = require('../../src/core/middleware/rateLimiters');
const { resolveClientIp } = require('../../src/core/middleware/clientIp');
const { errorHandler, notFoundHandler } = require('../../src/core/middleware/errorHandler');

const URL = '/api/v1/public/site-events';
const ORIGIN = 'https://zimos.co';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ALEXANDRIA = { 'cf-ipcountry': 'EG', 'cf-region-code': 'ALX' };
const SAVED = { geo: env.analytics.geoHeaders };

const rows = () => db.sequelize.query('SELECT * FROM site_visits ORDER BY created_at, id', { type: QueryTypes.SELECT });
const filterRows = async () => {
  await counters.flush();
  return db.TrafficFilterDay.findAll({ raw: true });
};
const sumOf = (list, where) => list.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).reduce((n, r) => n + Number(r.count), 0);

function send(body, { origin = ORIGIN, ua = CHROME, geo } = {}) {
  let req = request(app).post(URL).set('User-Agent', ua).set('Content-Type', 'text/plain');
  if (origin) req = req.set('Origin', origin);
  if (geo) for (const [k, v] of Object.entries(geo)) req = req.set(k, v);
  return req.send(JSON.stringify(body));
}

const ev = (over = {}) => ({ visitorId: 'visitor-site-0001', sessionId: 'session-site-0001', event: 'view', path: '/', locale: 'en', ...over });

beforeEach(async () => {
  env.siteAnalytics.enabled = true;
  env.siteAnalytics.detailsEnabled = true;
  env.siteAnalytics.origins = [ORIGIN];
  env.analytics.geoHeaders = ['cloudflare'];
  counters.reset();
  ipHash.reset();
  await db.sequelize.query('DELETE FROM user_acquisition');
  await db.sequelize.query('DELETE FROM site_visits');
});

afterEach(() => {
  env.siteAnalytics.enabled = false;
  env.siteAnalytics.detailsEnabled = false;
  env.siteAnalytics.origins = [];
  env.analytics.geoHeaders = SAVED.geo;
});

async function consoleApi(permissions = ['overview.view']) {
  const admin = await makePlatformUser('admin');
  await db.User.update({ platformPermissions: permissions }, { where: { id: admin.userId } });
  return (path) => request(app).get(`/api/v1/admin/site-traffic/${path}`).set(admin.H);
}

describe('the beacon', () => {
  it('off: stores exactly what it did, refuses the new field, counts no bot, and the console endpoints answer 404', async () => {
    env.siteAnalytics.detailsEnabled = false;
    expect((await send(ev(), { geo: ALEXANDRIA })).status).toBe(204);
    const [row] = await rows();
    expect(row).toMatchObject({ country: 'EG', browser: null, governorate: null, cta_kind: null });
    expect((await send(ev({ event: 'cta_click', cta: 'register' }))).status).toBe(422);
    expect((await send(ev(), { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })).status).toBe(204);
    expect((await send(ev(), { origin: 'https://evil.example' })).status).toBe(403);
    expect(await filterRows()).toEqual([]);

    const get = await consoleApi();
    for (const path of ['details/summary', 'campaigns', 'sessions', 'sessions/session-site-0001', 'protection']) {
      expect([path, (await get(path)).status]).toEqual([path, 404]);
    }
    expect((await get('summary')).status).toBe(200);
  });

  it('on: keeps the browser, the governorate from the region header (null without it) and the link kind', async () => {
    await send(ev(), { geo: ALEXANDRIA });
    await send(ev({ event: 'ping', path: '/pricing' }), { geo: ALEXANDRIA });
    await send(ev({ event: 'cta_click', path: '/pricing', cta: 'register' }), { geo: ALEXANDRIA });
    await send(ev({ sessionId: 'session-site-0002', visitorId: 'visitor-site-0002' }), { ua: IPHONE, geo: { 'cf-ipcountry': 'EG' } });
    const list = await rows();
    expect(list.map((r) => [r.event, r.path, r.browser, r.country, r.governorate, r.cta_kind, r.device_class])).toEqual([
      ['view', '/', 'chrome', 'EG', 'alexandria', null, 'desktop'],
      ['ping', '/pricing', 'chrome', 'EG', 'alexandria', null, 'desktop'],
      ['cta_click', '/pricing', 'chrome', 'EG', 'alexandria', 'register', 'desktop'],
      ['view', '/', 'ios', 'EG', null, null, 'mobile'],
    ]);
    expect(list[1].seconds_on_page).toBe(15);
    expect(JSON.stringify(list)).not.toMatch(/127\.0\.0\.1|::ffff/);
  });

  it('on: bots are classified and counted, never stored', async () => {
    await send(ev(), { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', geo: ALEXANDRIA });
    await send(ev(), { ua: 'python-requests/2.31.0' });
    expect(await rows()).toHaveLength(0);
    const counted = await filterRows();
    expect(sumOf(counted, { scope: 'site', kind: 'bot', reason: 'good_bot', label: 'search:googlebot', country: 'EG' })).toBe(1);
    expect(sumOf(counted, { scope: 'site', kind: 'bot', reason: 'bad_bot', label: 'tool:python' })).toBe(1);
  });

  it('on: refused requests keep their answers and are counted — origin, body, size and the per-IP limit', async () => {
    expect((await send(ev(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send({ ...ev(), extra: 1 })).status).toBe(422);
    expect((await send({ ...ev(), path: `/${'x'.repeat(3000)}` })).status).toBe(413);

    const mini = express();
    mini.use(resolveClientIp);
    mini.use(URL, createSiteEventsRouter({ limiter: createIpMinuteLimiter('site-events-details-test', 1) }));
    mini.use(notFoundHandler);
    mini.use(errorHandler);
    const post = () => request(mini).post(URL).set('Origin', ORIGIN).set('User-Agent', CHROME).set('Content-Type', 'text/plain').send(JSON.stringify(ev()));
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(429);

    expect(await rows()).toHaveLength(1);
    const counted = await filterRows();
    expect(sumOf(counted, { scope: 'site', kind: 'rejected', reason: 'origin_mismatch', label: 'evil.example' })).toBe(1);
    expect(sumOf(counted, { scope: 'site', kind: 'rejected', reason: 'invalid_body' })).toBe(1);
    expect(sumOf(counted, { scope: 'site', kind: 'rejected', reason: 'too_large' })).toBe(1);
    const limited = counted.filter((r) => r.reason === 'rate_ip');
    expect(limited).toHaveLength(1);
    expect(limited[0].label).toMatch(/^[0-9a-f]{16}$/);
    expect(counted.every((r) => r.scope === 'site' && r.workspaceId === null)).toBe(true);
  });
});

describe("the console's Site visits", () => {
  async function seed() {
    // A Facebook visit from Alexandria that signs up…
    await send(ev({ path: '/en', utmSource: 'facebook', utmMedium: 'cpc', utmCampaign: 'launch', referrer: 'https://www.facebook.com/' }), { geo: ALEXANDRIA });
    await send(ev({ event: 'ping', path: '/en' }), { geo: ALEXANDRIA });
    await send(ev({ event: 'ping', path: '/en' }), { geo: ALEXANDRIA });
    await send(ev({ path: '/en/pricing' }), { geo: ALEXANDRIA });
    await send(ev({ event: 'ping', path: '/en/pricing' }), { geo: ALEXANDRIA });
    await send(ev({ event: 'cta_click', path: '/en/pricing', cta: 'register' }), { geo: ALEXANDRIA });
    const signup = await request(app)
      .post('/api/v1/auth/register')
      .send({ phone: '01012345678', email: uniqueEmail('site'), password: 'Passw0rd!123', fullName: 'From the site', siteSessionId: 'session-site-0001' });
    expect(signup.status).toBe(201);
    // …a direct visit on a phone that only clicks sign-in…
    const b = { visitorId: 'visitor-site-0002', sessionId: 'session-site-0002' };
    await send(ev({ ...b, path: '/ar' }), { ua: IPHONE });
    await send(ev({ ...b, event: 'cta_click', path: '/ar', cta: 'login' }), { ua: IPHONE });
    // …and a Google visit that leaves.
    const c = { visitorId: 'visitor-site-0003', sessionId: 'session-site-0003' };
    await send(ev({ ...c, path: '/en/blog', referrer: 'https://www.google.com/' }));
    return { userId: signup.body.user.id };
  }

  it('summary: sessions, views, time per page from pings, the funnel, places, devices, browsers and sources', async () => {
    await seed();
    const get = await consoleApi();
    const res = await get('details/summary?range=7d');
    expect(res.status).toBe(200);
    const b = res.body;
    expect(b).toMatchObject({ range: '7d', sessions: 3, views: 4, signups: 1, conversionRate: 33.3 });
    expect(b.visitors).toBe(3);
    expect(b.avgSecondsPerSession).toBe(15);
    expect(b.funnel).toEqual([
      { key: 'visit', sessions: 3, dropRate: null },
      { key: 'signup_click', sessions: 1, dropRate: 66.7 },
      { key: 'signup', sessions: 1, dropRate: 0 },
    ]);
    expect(b.pages.find((p) => p.path === '/en')).toEqual({ path: '/en', views: 1, seconds: 30, avgSecondsPerView: 30 });
    expect(b.pages.find((p) => p.path === '/en/pricing')).toMatchObject({ views: 1, seconds: 15 });
    expect(b.governorates).toEqual([{ governorate: 'alexandria', sessions: 1 }]);
    expect(b.devices).toEqual(expect.arrayContaining([{ device: 'desktop', sessions: 2 }, { device: 'mobile', sessions: 1 }]));
    expect(b.browsers).toEqual(expect.arrayContaining([{ browser: 'chrome', sessions: 2 }, { browser: 'ios', sessions: 1 }]));
    expect(b.sources).toEqual(expect.arrayContaining([{ source: 'facebook', sessions: 1, signups: 1 }, { source: 'direct', sessions: 1, signups: 0 }, { source: 'www.google.com', sessions: 1, signups: 0 }]));
    expect(b.countries).toEqual(expect.arrayContaining([{ country: 'EG', sessions: 1 }]));
  });

  it('filters narrow everything: country, governorate, device, source', async () => {
    await seed();
    const get = await consoleApi();
    expect((await get('details/summary?governorate=alexandria')).body).toMatchObject({ sessions: 1, signups: 1 });
    expect((await get('details/summary?country=eg')).body.sessions).toBe(1);
    expect((await get('details/summary?device=mobile')).body).toMatchObject({ sessions: 1, signups: 0 });
    expect((await get('details/summary?source=direct')).body.sessions).toBe(1);
    expect((await get('details/summary?range=90d')).body.sessions).toBe(3);
    expect((await get('details/summary?governorate=atlantis')).status).toBe(422);
  });

  it('campaigns: utm source / medium / campaign with sessions, CTA clicks, sign-ups and conversion', async () => {
    await seed();
    const get = await consoleApi();
    const res = await get('campaigns');
    expect(res.body.campaigns).toEqual([{ source: 'facebook', medium: 'cpc', campaign: 'launch', sessions: 1, ctaClicks: 1, signups: 1, conversionRate: 100 }]);
  });

  it('visits: paged and sorted; one opens in order, linked to the account it created', async () => {
    const { userId } = await seed();
    const get = await consoleApi();
    const page = await get('sessions?sort=pages&pageSize=1');
    expect(page.body).toMatchObject({ total: 3, page: 1, pageSize: 1 });
    expect(page.body.sessions[0]).toMatchObject({
      sessionId: 'session-site-0001',
      source: 'facebook',
      landingPath: '/en',
      country: 'EG',
      governorate: 'alexandria',
      device: 'desktop',
      browser: 'chrome',
      pages: 2,
      seconds: 45,
      signedUp: true,
      userId,
    });
    expect((await get('sessions?sort=pages&pageSize=1&page=2')).body.sessions[0].signedUp).toBe(false);

    const one = await get('sessions/session-site-0001');
    expect(one.status).toBe(200);
    expect(one.body.session).toMatchObject({ userId, landingPath: '/en', utmCampaign: 'launch', seconds: 45 });
    expect(one.body.events.map((e) => e.type)).toEqual(['view', 'ping', 'ping', 'view', 'ping', 'cta_register', 'signup']);
    expect((await get('sessions/session-none-0001')).status).toBe(404);
  });

  it("protection: what the beacon's guard kept out, apart from the stores'", async () => {
    await send(ev(), { ua: 'curl/8.4.0' });
    counters.recordFiltered({ workspaceId: null, kind: 'rejected', reason: 'too_large' });
    await counters.flush();
    const get = await consoleApi();
    const site = await get('protection?range=today');
    expect(site.status).toBe(200);
    expect(site.body).toMatchObject({ scope: 'site', enabled: true, totals: { bot: 1, rejected: 0, suspicious: 0, capped: 0 }, cappedStores: [], flaggedSessions: [] });

    const admin = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['workspaces.view'] }, { where: { id: admin.userId } });
    const stores = await request(app).get('/api/v1/admin/store-traffic/protection?range=today').set(admin.H);
    expect(stores.body.totals).toEqual({ bot: 0, rejected: 1, suspicious: 0, capped: 0 });
  });

  it('needs overview.view, as Site traffic does', async () => {
    const get = await consoleApi(['workspaces.view']);
    expect((await get('details/summary')).status).toBe(403);
    expect((await get('sessions')).status).toBe(403);
  });
});
