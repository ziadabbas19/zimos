'use strict';

// Device notifications (notifications/push, /api/v1/me/push): off is exactly
// as before; on, a browser subscribes under its sign-in session, follows it
// through refreshes and goes with it; the test notification carries an
// allowlisted payload only; and the push service's answers are recorded.

const crypto = require('crypto');
const webpush = require('web-push');
const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { verifyAccessToken } = require('../../src/core/security/tokens');
const pushPayload = require('../../src/modules/notifications/push/pushPayload');
const pushService = require('../../src/modules/notifications/push/pushService');

const loaded = { ...env.push };
const DAY_MS = 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let sendSpy;
beforeEach(() => {
  sendSpy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
});
afterEach(() => {
  sendSpy.mockRestore();
  Object.assign(env.push, loaded);
});

function pushOn() {
  const keys = webpush.generateVAPIDKeys();
  Object.assign(env.push, { enabled: true, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:ops@zimos.test' });
  return keys;
}

const H = (token) => ({ Authorization: `Bearer ${token}` });
const sidOf = (token) => verifyAccessToken(token).sid;

let counter = 0;
function browser(host = 'https://fcm.googleapis.com/fcm/send/') {
  counter += 1;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `${host}device-${Date.now()}-${counter}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

const subscribe = (token, subscription, extra = {}) =>
  request(app)
    .put('/api/v1/me/push/subscriptions')
    .set(H(token))
    .set('User-Agent', UA)
    .send({ app: 'dashboard', subscription, locale: 'en', ...extra });
const testPush = (token, body = {}) => request(app).post('/api/v1/me/push/test').set(H(token)).send(body);
const refresh = (refreshToken) => request(app).post('/api/v1/auth/refresh').send({ refreshToken });
const login = (u) => request(app).post('/api/v1/auth/login').send({ email: u.email, password: u.password });
const rowOf = (endpoint) => db.PushSubscription.findOne({ where: { endpoint } });

async function subscribed(user, sub = browser()) {
  const res = await subscribe(user.accessToken, sub);
  expect(res.status).toBe(200);
  return { sub, id: res.body.subscription.id };
}

describe('switched off: exactly as before', () => {
  const paths = (id) => [
    ['get', '/api/v1/me/push/config'],
    ['put', '/api/v1/me/push/subscriptions'],
    ['get', '/api/v1/me/push/subscriptions'],
    ['patch', `/api/v1/me/push/subscriptions/${id}`],
    ['delete', `/api/v1/me/push/subscriptions/${id}`],
    ['post', '/api/v1/me/push/test'],
  ];

  it('every /me/push path answers 404 with PUSH_ENABLED off, even with a pair, and with it on but no pair', async () => {
    const user = await registerAndActivate();
    const keys = webpush.generateVAPIDKeys();
    Object.assign(env.push, { enabled: false, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:ops@zimos.test' });
    for (const [method, path] of paths(crypto.randomUUID())) {
      const res = await request(app)[method](path).set(H(user.accessToken)).send({});
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    Object.assign(env.push, { enabled: true, vapidPublicKey: '', vapidPrivateKey: '' });
    for (const [method, path] of paths(crypto.randomUUID())) {
      expect((await request(app)[method](path).set(H(user.accessToken)).send({})).status).toBe(404);
    }
    expect(await db.PushSubscription.count()).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('the notification settings offer no push column', async () => {
    const owner = await registerAndActivate();
    const workspace = await createWorkspace(owner.accessToken);
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/notifications/preferences`).set(H(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual(['inApp', 'email', 'whatsapp']);
  });

  it('a refresh, a sign-out and the daily cleanup leave push_subscriptions alone', async () => {
    pushOn();
    const user = await registerAndActivate();
    const first = await subscribed(user);
    const other = (await login(user)).body;
    const second = await subscribed(other);
    Object.assign(env.push, loaded);

    // Refreshed while off: the device stays on the session it was made under.
    const next = await refresh(user.refreshToken);
    expect(next.status).toBe(200);
    expect((await rowOf(first.sub.endpoint)).sessionId).toBe(sidOf(user.accessToken));
    // Signed out while off: the device stays.
    expect((await request(app).post('/api/v1/auth/logout').send({ refreshToken: other.refreshToken })).status).toBe(200);
    expect(await rowOf(second.sub.endpoint)).not.toBeNull();
    expect(await pushService.cleanup()).toEqual({ skipped: true });
    expect(await db.PushSubscription.count()).toBe(2);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('switched on', () => {
  beforeEach(() => pushOn());

  it('GET /config hands out the public key, to a signed-in account only', async () => {
    const user = await registerAndActivate();
    const res = await request(app).get('/api/v1/me/push/config').set(H(user.accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, publicKey: env.push.vapidPublicKey });
    expect(JSON.stringify(res.body)).not.toContain(env.push.vapidPrivateKey);
    expect((await request(app).get('/api/v1/me/push/config')).status).toBe(401);
  });

  it('the notification settings offer the push column', async () => {
    const owner = await registerAndActivate();
    const workspace = await createWorkspace(owner.accessToken);
    const res = await request(app).get(`/api/v1/workspaces/${workspace.id}/notifications/preferences`).set(H(owner.accessToken));
    expect(res.body.channels).toEqual(['inApp', 'email', 'push', 'whatsapp']);
  });

  it('a browser subscribes under the session it signed in with; the answer never repeats its endpoint or keys', async () => {
    const user = await registerAndActivate();
    const sub = browser();
    const res = await subscribe(user.accessToken, sub);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ app: 'dashboard', deviceLabel: 'Chrome on Windows', pushService: 'fcm', locale: 'en', enabled: true, current: true });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(sub.endpoint);
    expect(text).not.toContain(sub.keys.p256dh);
    expect(text).not.toContain(sub.keys.auth);
    const row = await rowOf(sub.endpoint);
    expect(row).toMatchObject({ userId: user.userId, sessionId: sidOf(user.accessToken), p256dh: sub.keys.p256dh, auth: sub.keys.auth });
    expect(row.endpointHash).toBe(crypto.createHash('sha256').update(sub.endpoint).digest('hex'));
  });

  it('refuses endpoints outside the push services, and malformed keys', async () => {
    const user = await registerAndActivate();
    const outside = await subscribe(user.accessToken, browser('https://example.com/push/'));
    expect(outside.status).toBe(422);
    expect(outside.body.error.code).toBe('PUSH_ENDPOINT_NOT_ALLOWED');
    const invalid = async (sub, extra) => {
      const res = await subscribe(user.accessToken, sub, extra);
      expect([res.status, res.body.error.code]).toEqual([422, 'VALIDATION_ERROR']);
    };
    await invalid(browser('http://fcm.googleapis.com/fcm/send/'));
    const badKeys = browser();
    // 65 bytes, but not an uncompressed point (those start with 0x04).
    badKeys.keys.p256dh = Buffer.concat([Buffer.from([5]), crypto.randomBytes(64)]).toString('base64url');
    await invalid(badKeys);
    const shortAuth = browser();
    shortAuth.keys.auth = crypto.randomBytes(8).toString('base64url');
    await invalid(shortAuth);
    await invalid(browser(), { app: 'storefront' });
    expect(await db.PushSubscription.count()).toBe(0);
  });

  it('the same browser again is one row: its keys refreshed, its switch kept', async () => {
    const user = await registerAndActivate();
    const { sub, id } = await subscribed(user);
    expect((await request(app).patch(`/api/v1/me/push/subscriptions/${id}`).set(H(user.accessToken)).send({ enabled: false })).status).toBe(200);
    const again = { ...sub, keys: browser().keys };
    const res = await subscribe(user.accessToken, again);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({ id, enabled: false });
    expect(await db.PushSubscription.count()).toBe(1);
    expect((await rowOf(sub.endpoint)).p256dh).toBe(again.keys.p256dh);
  });

  it('another account signing in on the same browser takes it over, switched on afresh', async () => {
    const first = await registerAndActivate();
    const second = await registerAndActivate();
    const { sub, id } = await subscribed(first);
    await db.PushSubscription.update({ enabled: false, failureCount: 5 }, { where: { id } });
    const res = await subscribe(second.accessToken, sub);
    expect(res.status).toBe(200);
    const row = await rowOf(sub.endpoint);
    expect(row).toMatchObject({ id, userId: second.userId, sessionId: sidOf(second.accessToken), enabled: true, failureCount: 0 });
    const firstList = await request(app).get('/api/v1/me/push/subscriptions').set(H(first.accessToken));
    expect(firstList.body.subscriptions).toEqual([]);
  });

  it('the console app is for console accounts only', async () => {
    const merchant = await registerAndActivate();
    const admin = await makePlatformUser('admin');
    expect((await subscribe(merchant.accessToken, browser(), { app: 'console' })).status).toBe(403);
    const res = await subscribe(admin.accessToken, browser(), { app: 'console' });
    expect(res.status).toBe(200);
    expect(res.body.subscription.app).toBe('console');
  });

  it('keeps PUSH_MAX_DEVICES_PER_USER devices per app: the least recently seen goes', async () => {
    env.push.maxDevicesPerUser = 2;
    const user = await registerAndActivate();
    const oldest = await subscribed(user);
    await db.PushSubscription.update({ lastSeenAt: new Date(Date.now() - DAY_MS) }, { where: { id: oldest.id } });
    const second = await subscribed(user);
    const third = await subscribed(user);
    const ids = (await db.PushSubscription.findAll({ where: { userId: user.userId } })).map((r) => r.id).sort();
    expect(ids).toEqual([second.id, third.id].sort());
  });

  it('my devices: listed, switched and removed by their owner only', async () => {
    const owner = await registerAndActivate();
    const other = await registerAndActivate();
    const { id } = await subscribed(owner);
    const list = await request(app).get('/api/v1/me/push/subscriptions').set(H(owner.accessToken));
    expect(list.body.subscriptions).toHaveLength(1);
    expect(list.body.subscriptions[0]).toMatchObject({ id, current: true });
    expect(list.body.subscriptions[0].endpoint).toBeUndefined();
    expect((await request(app).get('/api/v1/me/push/subscriptions').set(H(other.accessToken))).body.subscriptions).toEqual([]);
    expect((await request(app).patch(`/api/v1/me/push/subscriptions/${id}`).set(H(other.accessToken)).send({ enabled: false })).status).toBe(404);
    expect((await request(app).delete(`/api/v1/me/push/subscriptions/${id}`).set(H(other.accessToken))).status).toBe(404);
    expect((await testPush(other.accessToken, { id })).status).toBe(404);
    expect((await request(app).delete(`/api/v1/me/push/subscriptions/${id}`).set(H(owner.accessToken))).status).toBe(200);
    expect(await db.PushSubscription.count()).toBe(0);
  });
});

describe('the test notification', () => {
  beforeEach(() => pushOn());

  it('goes to this browser only, signed with the VAPID pair, carrying the allowlisted fields and nothing personal', async () => {
    const user = await registerAndActivate({ fullName: 'Mona Adel Private' });
    const workspace = await createWorkspace(user.accessToken, 'Mona Private Store');
    const here = await subscribed(user);
    const elsewhere = await login(user);
    await subscribed(elsewhere.body);

    const res = await testPush(user.accessToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 1, results: [{ id: here.id, outcome: 'sent' }] });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [target, payload, options] = sendSpy.mock.calls[0];
    expect(target).toEqual({ endpoint: here.sub.endpoint, keys: here.sub.keys });
    expect(options).toMatchObject({ vapidDetails: { subject: 'mailto:ops@zimos.test', publicKey: env.push.vapidPublicKey, privateKey: env.push.vapidPrivateKey }, TTL: 300 });

    const parsed = JSON.parse(payload);
    expect(Object.keys(parsed).sort()).toEqual([...pushPayload.FIELDS].sort());
    expect(parsed).toMatchObject({ type: 'push.test', url: '/settings?tab=notifications', tag: 'push.test' });
    expect(parsed.body).toMatch(/test notification/);
    for (const personal of [user.email, '01012345678', 'Mona', 'Private', workspace.id, user.userId]) expect(payload).not.toContain(personal);

    const row = await rowOf(here.sub.endpoint);
    expect(row.lastSuccessAt).not.toBeNull();
  });

  it('answers 404 when this browser has not subscribed, and 409 when it is switched off', async () => {
    const user = await registerAndActivate();
    expect((await testPush(user.accessToken)).body.error.code).toBe('PUSH_NO_DEVICE');
    const { id } = await subscribed(user);
    await request(app).patch(`/api/v1/me/push/subscriptions/${id}`).set(H(user.accessToken)).send({ enabled: false });
    const off = await testPush(user.accessToken);
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('PUSH_DEVICE_DISABLED');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it.each([404, 410])('a device the push service no longer knows (%i) is deleted', async (status) => {
    const user = await registerAndActivate();
    const { sub } = await subscribed(user);
    sendSpy.mockRejectedValue(new webpush.WebPushError('Received unexpected response code', status, {}, '', sub.endpoint));
    const res = await testPush(user.accessToken);
    expect(res.body.results[0].outcome).toBe('gone');
    expect(await rowOf(sub.endpoint)).toBeNull();
  });

  it('429 is a retry, not a failure; a 403 is a failure; five failures in a row switch the device off', async () => {
    const user = await registerAndActivate();
    const { sub, id } = await subscribed(user);
    const answer = (status, headers = {}) => sendSpy.mockRejectedValueOnce(new webpush.WebPushError('Received unexpected response code', status, headers, '', sub.endpoint));

    answer(429, { 'retry-after': '30' });
    expect((await testPush(user.accessToken)).body.results[0].outcome).toBe('retry');
    expect(await rowOf(sub.endpoint)).toMatchObject({ failureCount: 0, enabled: true, lastError: 'HTTP 429' });

    answer(403);
    expect((await testPush(user.accessToken)).body.results[0].outcome).toBe('failed');
    expect(await rowOf(sub.endpoint)).toMatchObject({ failureCount: 1, lastError: 'HTTP 403' });

    for (let i = 0; i < 4; i += 1) {
      answer(503);
      expect((await testPush(user.accessToken)).body.results[0].outcome).toBe('retry');
    }
    expect(await rowOf(sub.endpoint)).toMatchObject({ failureCount: 5, enabled: false, lastError: 'HTTP 503' });

    const back = await request(app).patch(`/api/v1/me/push/subscriptions/${id}`).set(H(user.accessToken)).send({ enabled: true });
    expect(back.body.subscription.enabled).toBe(true);
    expect(await rowOf(sub.endpoint)).toMatchObject({ failureCount: 0, lastError: null });
    expect((await testPush(user.accessToken)).body.results[0].outcome).toBe('sent');
  });

  it('a device whose endpoint is no longer a push service is deleted, never sent to', async () => {
    const user = await registerAndActivate();
    const { sub, id } = await subscribed(user);
    await db.PushSubscription.update({ endpoint: 'https://example.com/collect' }, { where: { id } });
    const res = await testPush(user.accessToken);
    expect(res.body.results[0].outcome).toBe('gone');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await rowOf(sub.endpoint)).toBeNull();
  });
});

describe('bound to the sign-in session', () => {
  beforeEach(() => pushOn());

  it('follows the session through refreshes, past the session gate’s 50-step chain', async () => {
    const user = await registerAndActivate();
    const { sub } = await subscribed(user);
    let tokens = user;
    for (let i = 0; i < 52; i += 1) {
      const res = await refresh(tokens.refreshToken);
      expect(res.status).toBe(200);
      tokens = res.body;
    }
    expect((await rowOf(sub.endpoint)).sessionId).toBe(sidOf(tokens.accessToken));
    const res = await testPush(tokens.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
  }, 180000);

  it('signing out removes this browser’s device and keeps the other device’s', async () => {
    const user = await registerAndActivate();
    const here = await subscribed(user);
    const other = (await login(user)).body;
    const there = await subscribed(other);
    expect((await request(app).post('/api/v1/auth/logout').send({ refreshToken: user.refreshToken })).status).toBe(200);
    expect(await rowOf(here.sub.endpoint)).toBeNull();
    expect(await rowOf(there.sub.endpoint)).not.toBeNull();
  });

  it('"sign out of all devices" removes every device of the account, and no other account’s', async () => {
    const user = await registerAndActivate();
    const stranger = await registerAndActivate();
    await subscribed(user);
    await subscribed((await login(user)).body);
    const theirs = await subscribed(stranger);
    expect((await request(app).post('/api/v1/auth/sessions/revoke-all').set(H(user.accessToken))).status).toBe(200);
    expect(await db.PushSubscription.count({ where: { userId: user.userId } })).toBe(0);
    expect(await rowOf(theirs.sub.endpoint)).not.toBeNull();
  });

  it('a suspended account loses its devices with its sessions', async () => {
    const user = await registerAndActivate();
    await subscribed(user);
    const admin = await makePlatformUser('admin');
    const res = await request(app).post(`/api/v1/admin/users/${user.userId}/suspend`).set(admin.H).send({ reason: 'Fraud reports', confirm: true });
    expect(res.status).toBe(200);
    expect(await db.PushSubscription.count({ where: { userId: user.userId } })).toBe(0);
  });

  it('a device of a session that expired is deleted when sent to, not sent', async () => {
    const user = await registerAndActivate();
    const old = await subscribed(user);
    const now = (await login(user)).body;
    await db.Session.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: sidOf(user.accessToken) } });
    const res = await testPush(now.accessToken, { id: old.id });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ id: old.id, outcome: 'gone' }]);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await rowOf(old.sub.endpoint)).toBeNull();
  });

  it('the daily cleanup: ended sessions’ devices and devices unseen for 60 days go, a device left behind a refresh catches up', async () => {
    const user = await registerAndActivate();
    const expired = await subscribed(user);
    await db.Session.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: sidOf(user.accessToken) } });

    const live = (await login(user)).body;
    const unseen = await subscribed(live);
    await db.PushSubscription.update({ lastSeenAt: new Date(Date.now() - 61 * DAY_MS) }, { where: { id: unseen.id } });

    const moving = (await login(user)).body;
    const behind = await subscribed(moving);
    const oldSid = sidOf(moving.accessToken);
    const next = (await refresh(moving.refreshToken)).body;
    await db.PushSubscription.update({ sessionId: oldSid }, { where: { id: behind.id } });

    const kept = await subscribed(live);

    expect(await pushService.cleanup()).toEqual({ removed: 1, moved: 1, stale: 1 });
    expect(await rowOf(expired.sub.endpoint)).toBeNull();
    expect(await rowOf(unseen.sub.endpoint)).toBeNull();
    expect((await rowOf(behind.sub.endpoint)).sessionId).toBe(sidOf(next.accessToken));
    expect(await rowOf(kept.sub.endpoint)).not.toBeNull();
  });
});
