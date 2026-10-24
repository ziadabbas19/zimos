'use strict';

// The console's Live view of zimos.co (siteAnalytics/siteTrafficLive.js), the
// operating system the beacon now keeps (migration 709), and the deletion of
// old visits (SITE_VISITS_RETENTION_DAYS) — each off by default, and off
// nothing changes.

const { QueryTypes } = require('sequelize');
const { app, request, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { getClientInfo } = require('../../src/modules/analytics/clientDetect');
const retention = require('../../src/modules/siteAnalytics/siteVisitsRetention');
const siteVisitsTasks = require('../../src/modules/siteAnalytics/jobs');

const URL = '/api/v1/public/site-events';
const ORIGIN = 'https://zimos.co';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ALEXANDRIA = { 'cf-ipcountry': 'EG', 'cf-region-code': 'ALX' };
const SAVED = { geo: env.analytics.geoHeaders, retention: env.siteVisitsRetentionDays };

const rows = () => db.sequelize.query('SELECT * FROM site_visits ORDER BY created_at, id', { type: QueryTypes.SELECT });

function send(body, { ua = IPHONE, geo = ALEXANDRIA } = {}) {
  let req = request(app).post(URL).set('User-Agent', ua).set('Content-Type', 'text/plain').set('Origin', ORIGIN);
  for (const [k, v] of Object.entries(geo)) req = req.set(k, v);
  return req.send(JSON.stringify(body));
}

const ev = (over = {}) => ({ visitorId: 'visitor-live-0001', sessionId: 'session-live-0001', event: 'view', path: '/', locale: 'ar', ...over });

/** A row written straight to the table, `ago` seconds old. */
function insertVisit({ sessionId, event = 'view', path = '/', ago, country = null }) {
  return db.sequelize.query(
    `INSERT INTO site_visits (visitor_hash, session_id, path, device_class, country, event, created_at)
     VALUES ('h-${sessionId}', :sessionId, :path, 'desktop', :country, :event, now() - make_interval(secs => :ago))`,
    { replacements: { sessionId, path, country, event, ago } }
  );
}

beforeEach(async () => {
  env.siteAnalytics.enabled = true;
  env.siteAnalytics.detailsEnabled = true;
  env.siteAnalytics.origins = [ORIGIN];
  env.analytics.geoHeaders = ['cloudflare'];
  await db.sequelize.query('DELETE FROM user_acquisition');
  await db.sequelize.query('DELETE FROM site_visits');
});

afterEach(() => {
  env.siteAnalytics.enabled = false;
  env.siteAnalytics.detailsEnabled = false;
  env.siteAnalytics.origins = [];
  env.analytics.geoHeaders = SAVED.geo;
  env.siteVisitsRetentionDays = SAVED.retention;
});

async function consoleApi(permissions = ['overview.view']) {
  const admin = await makePlatformUser('admin');
  await db.User.update({ platformPermissions: permissions }, { where: { id: admin.userId } });
  return () => request(app).get('/api/v1/admin/site-traffic/live').set(admin.H);
}

describe('the Live view', () => {
  it('off: answers 404, and the beacon keeps no operating system', async () => {
    env.siteAnalytics.detailsEnabled = false;
    expect((await send(ev())).status).toBe(204);
    const [row] = await rows();
    expect(row.os).toBe(null);
    expect(row.browser).toBe(null);
    const live = await consoleApi();
    expect((await live()).status).toBe(404);
  });

  it('needs overview.view', async () => {
    const live = await consoleApi(['workspaces.view']);
    expect((await live()).status).toBe(403);
  });

  it('lists the sessions of the last five minutes: first view, page now, last CTA, device, browser and system', async () => {
    expect((await send(ev({ referrer: 'https://www.google.com/search?q=zimos', utmSource: 'facebook', utmMedium: 'cpc', utmCampaign: 'launch' }))).status).toBe(204);
    expect((await send(ev({ event: 'ping', path: '/pricing' }))).status).toBe(204);
    expect((await send(ev({ event: 'cta_click', path: '/pricing', cta: 'register' }))).status).toBe(204);
    // Seen two minutes ago: still listed, not active. Ten minutes ago: gone.
    await insertVisit({ sessionId: 'session-live-quiet', path: '/blog', ago: 120, country: 'SA' });
    await insertVisit({ sessionId: 'session-live-gone', path: '/old', ago: 600 });

    const res = await (await consoleApi())();
    expect(res.status).toBe(200);
    expect(res.body.windowSeconds).toBe(300);
    expect(res.body.active).toBe(1);
    expect(res.body.visitors.map((v) => v.sessionId)).toEqual(['session-live-0001', 'session-live-quiet']);

    const expected = getClientInfo({ userAgent: IPHONE });
    const [now, quiet] = res.body.visitors;
    expect(now).toMatchObject({
      active: true,
      country: 'EG',
      governorate: 'alexandria',
      source: 'facebook',
      utmSource: 'facebook',
      utmMedium: 'cpc',
      utmCampaign: 'launch',
      referrerHost: 'www.google.com',
      device: 'mobile',
      browser: expected.browser,
      os: expected.os,
      locale: 'ar',
      currentPath: '/pricing',
    });
    expect(expected.os).toBeTruthy();
    expect(now.lastCta.kind).toBe('register');
    expect(quiet).toMatchObject({ active: false, country: 'SA', currentPath: '/blog', os: null, lastCta: null });

    // The day's visitor hash is never sent.
    const [stored] = await rows();
    expect(JSON.stringify(res.body)).not.toContain(stored.visitor_hash);
    expect(Object.keys(now)).not.toContain('visitorHash');
  });
});

describe('SITE_VISITS_RETENTION_DAYS', () => {
  it('unset (0): deletes nothing', async () => {
    env.siteVisitsRetentionDays = 0;
    await insertVisit({ sessionId: 'session-old-0001', ago: 400 * 86400 });
    expect(await retention.run()).toEqual({ enabled: false });
    expect(await rows()).toHaveLength(1);
  });

  it('set: deletes the visits older than that, keeps the rest and every account acquisition', async () => {
    env.siteVisitsRetentionDays = 30;
    await insertVisit({ sessionId: 'session-old-0001', ago: 40 * 86400 });
    await insertVisit({ sessionId: 'session-new-0001', ago: 20 * 86400 });
    const admin = await makePlatformUser('admin');
    await db.sequelize.query(
      `INSERT INTO user_acquisition (user_id, session_id, first_visit_at) VALUES (:userId, 'session-old-0001', now() - interval '40 days')`,
      { replacements: { userId: admin.userId } }
    );

    expect(await retention.run()).toEqual({ enabled: true, removed: 1 });
    expect((await rows()).map((r) => r.session_id)).toEqual(['session-new-0001']);
    const [acq] = await db.sequelize.query('SELECT count(*)::int AS n FROM user_acquisition', { type: QueryTypes.SELECT });
    expect(acq.n).toBe(1);
  });

  it('runs from a schedule of its own', () => {
    expect(siteVisitsTasks.schedules.map((s) => s.name)).toEqual(['site_analytics.visits_retention']);
  });
});
