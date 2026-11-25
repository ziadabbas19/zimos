'use strict';

// Who a zimos.co visitor is, for the console's Site visits
// (SITE_VISITOR_DETAILS_ENABLED, migration 752): the device, first visit or
// returning, and the account once the browser signs in. Off, nothing new is
// stored and the visits read as before, with null for every new field.

const { QueryTypes } = require('sequelize');
const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const siteTraffic = require('../../src/modules/siteAnalytics/siteTrafficService');

const URL = '/api/v1/public/site-events';
const ORIGIN = 'https://zimos.co';
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const NEW_FIELDS = { screen: '412x915', language: 'ar-EG', signedIn: false, uaModel: 'Pixel 7', uaPlatformVersion: '14.0.0' };

const rows = () => db.sequelize.query('SELECT * FROM site_visits ORDER BY created_at, id', { type: QueryTypes.SELECT });

function send(body, { ua = ANDROID } = {}) {
  return request(app).post(URL).set('User-Agent', ua).set('Origin', ORIGIN).set('Content-Type', 'text/plain').send(JSON.stringify(body));
}

const ev = (over = {}) => ({ visitorId: 'visitor-key-0001', sessionId: 'session-key-0001', event: 'view', path: '/ar', locale: 'ar', ...over });

/** Moves a session's rows back in time, as if it happened `days` ago. */
const age = (sessionId, days) =>
  db.sequelize.query(`UPDATE site_visits SET created_at = created_at - make_interval(days => :days) WHERE session_id = :sessionId`, {
    replacements: { days, sessionId },
  });

async function consoleApi() {
  const admin = await makePlatformUser('admin');
  await db.User.update({ platformPermissions: ['overview.view'] }, { where: { id: admin.userId } });
  return (path) => request(app).get(`/api/v1/admin/site-traffic/${path}`).set(admin.H);
}

beforeEach(async () => {
  env.siteAnalytics.enabled = true;
  env.siteAnalytics.detailsEnabled = true;
  env.siteAnalytics.visitorDetailsEnabled = true;
  env.siteAnalytics.origins = [ORIGIN];
  await db.sequelize.query('DELETE FROM site_visitor_accounts');
  await db.sequelize.query('DELETE FROM user_acquisition');
  await db.sequelize.query('DELETE FROM site_visits');
});

afterEach(() => {
  env.siteAnalytics.enabled = false;
  env.siteAnalytics.detailsEnabled = false;
  env.siteAnalytics.visitorDetailsEnabled = false;
  env.siteAnalytics.origins = [];
});

describe('the beacon', () => {
  it('off: accepts the new fields and stores none of them', async () => {
    env.siteAnalytics.visitorDetailsEnabled = false;
    expect((await send(ev(NEW_FIELDS))).status).toBe(204);
    const [row] = await rows();
    expect(row).toMatchObject({ visitor_key: null, device_model: null, os_version: null, browser_version: null, screen: null, language: null, signed_in: null, os: null });
  });

  it('on: a visitor key that does not change with the day, and the device', async () => {
    expect((await send(ev(NEW_FIELDS))).status).toBe(204);
    expect((await send(ev({ event: 'ping' }), { ua: ANDROID })).status).toBe(204);
    const [view, ping] = await rows();
    expect(view).toMatchObject({
      visitor_key: siteTraffic.visitorKey('visitor-key-0001'),
      device_class: 'mobile',
      device_model: 'Pixel 7',
      os: 'Android OS',
      os_version: '14',
      browser: 'chrome',
      browser_version: '131',
      screen: '412x915',
      language: 'ar-EG',
      signed_in: false,
    });
    expect(view.visitor_key).not.toBe(view.visitor_hash);
    // A ping carries no hints: what the agent hides stays null, nothing guessed.
    expect(ping).toMatchObject({ visitor_key: view.visitor_key, device_model: null, os_version: null, screen: null, signed_in: null });
  });
});

describe("the console's Visits", () => {
  it('first visit or returning, with the time of the previous one; older visits are unknown', async () => {
    await send(ev({ sessionId: 'session-key-0001' }));
    await age('session-key-0001', 3);
    await send(ev({ sessionId: 'session-key-0002', ...NEW_FIELDS, signedIn: true }));
    env.siteAnalytics.visitorDetailsEnabled = false;
    await send(ev({ visitorId: 'visitor-key-0002', sessionId: 'session-key-0003' }));

    const get = await consoleApi();
    const res = await get('sessions?range=7d&sort=started');
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.sessions.map((s) => [s.sessionId, s]));
    const [first] = (await rows()).filter((r) => r.session_id === 'session-key-0001');

    expect(by['session-key-0001']).toMatchObject({ returning: false, previousVisitAt: null, account: null });
    expect(by['session-key-0002']).toMatchObject({
      returning: true,
      model: 'Pixel 7',
      os: 'Android',
      osVersion: '14',
      browserVersion: '131',
      screen: '412x915',
      language: 'ar-EG',
      signedIn: true,
    });
    expect(new Date(by['session-key-0002'].previousVisitAt).getTime()).toBe(new Date(first.created_at).getTime());
    expect(by['session-key-0003']).toMatchObject({ returning: null, previousVisitAt: null, model: null, signedIn: null, account: null });
    expect(by['session-key-0002']).not.toHaveProperty('visitorKey');

    const one = await get('sessions/session-key-0002');
    expect(one.body.session).toMatchObject({ returning: true, signedIn: true, model: 'Pixel 7', osVersion: '14' });
  });

  it('a sign-in from a marketing link ties every visit of that browser to the account, earlier ones too', async () => {
    const user = await registerAndActivate({ fullName: 'Visitor Account' });
    await send(ev({ sessionId: 'session-key-0001' }));
    await age('session-key-0001', 2);
    await send(ev({ sessionId: 'session-key-0002' }));

    const login = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: user.password, siteSessionId: 'session-key-0002' });
    expect(login.status).toBe(200);
    // The sign-in answers without waiting for the link; give it a moment.
    let linked = [];
    for (let i = 0; i < 50 && linked.length === 0; i += 1) {
      linked = await db.sequelize.query('SELECT * FROM site_visitor_accounts', { type: QueryTypes.SELECT });
      if (linked.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(linked).toEqual([expect.objectContaining({ visitor_key: siteTraffic.visitorKey('visitor-key-0001'), user_id: user.userId })]);
    // No visit row was rewritten.
    expect((await rows()).every((r) => r.user_id === null)).toBe(true);

    const get = await consoleApi();
    const res = await get('sessions?range=7d');
    for (const s of res.body.sessions) expect(s.account).toEqual({ id: user.userId, name: 'Visitor Account' });
  });

  it('linkVisitor does nothing while the switch is off, and never throws', async () => {
    const user = await registerAndActivate();
    await send(ev());
    env.siteAnalytics.visitorDetailsEnabled = false;
    siteTraffic.linkVisitor(user.userId, 'session-key-0001');
    env.siteAnalytics.visitorDetailsEnabled = true;
    await siteTraffic.attachVisitor(user.userId, 'session-none-0001');
    expect(await db.sequelize.query('SELECT * FROM site_visitor_accounts', { type: QueryTypes.SELECT })).toEqual([]);
    expect(() => siteTraffic.linkVisitor(user.userId, 'not a session id')).not.toThrow();
  });
});
