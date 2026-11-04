'use strict';

// Two-step sign-in (auth/twoFactorService, twoFactorRecovery, securityRoutes)
// behind TWO_FACTOR_ENABLED, and the new-device email code behind
// NEW_DEVICE_CODE. Both off: sign-in exactly as before.

const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const { totpAt } = require('../../src/modules/auth/twoFactorService');

let emailSpy;
beforeEach(() => {
  emailSpy = jest.spyOn(notify, 'email');
});
afterEach(() => {
  env.twoFactor.enabled = false;
  env.newDevice.code = false;
  env.newDevice.alert = false;
  jest.restoreAllMocks();
});

const bearer = (u) => ({ Authorization: `Bearer ${u.accessToken}` });
const login = (u, cookie) => {
  const req = request(app).post('/api/v1/auth/login').send({ email: u.email, password: u.password });
  return cookie ? req.set('Cookie', cookie) : req;
};
const verify = (body, cookie) => {
  const req = request(app).post('/api/v1/auth/two-factor/verify').send(body);
  return cookie ? req.set('Cookie', cookie) : req;
};
const lastCode = () => {
  const call = [...emailSpy.mock.calls].reverse().find((c) => c[0].template === 'login_code');
  return call ? call[0].data.code : null;
};

describe('two-step sign-in, switched off (the default)', () => {
  it('answers 404 on its settings and signs in as before', async () => {
    const user = await registerAndActivate();
    const settings = await request(app).get('/api/v1/auth/two-factor').set(bearer(user));
    expect(settings.status).toBe(404);
    expect(settings.body.error.code).toBe('TWO_FACTOR_UNAVAILABLE');
    // A row set up while it was on asks for nothing while it is off.
    await db.UserTwoFactor.create({ userId: user.userId, mode: 'email', enabledAt: new Date() });
    const res = await login(user);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.twoFactorRequired).toBeUndefined();
  });
});

describe('two-step sign-in, switched on', () => {
  beforeEach(() => {
    env.twoFactor.enabled = true;
  });

  it('email: a code by email, a wrong code refused, the right one signs in, and a remembered browser skips it', async () => {
    const user = await registerAndActivate();
    const wrongPassword = await request(app).post('/api/v1/auth/two-factor/email/enable').set(bearer(user)).send({ password: 'not-it' });
    expect(wrongPassword.status).toBe(422);
    const on = await request(app).post('/api/v1/auth/two-factor/email/enable').set(bearer(user)).send({ password: user.password });
    expect(on.status).toBe(200);
    expect(on.body.mode).toBe('email');

    const first = await login(user);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ twoFactorRequired: true, channel: 'email' });
    expect(first.body.accessToken).toBeUndefined();

    const wrong = await verify({ challengeToken: first.body.challengeToken, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_TWO_FACTOR_CODE');

    const done = await verify({ challengeToken: first.body.challengeToken, code: lastCode(), rememberDevice: true });
    expect(done.status).toBe(200);
    expect(done.body.accessToken).toBeTruthy();
    const cookie = done.headers['set-cookie'].find((c) => c.startsWith('zimos_dev')).split(';')[0];

    // The same code again: the challenge is used up.
    expect((await verify({ challengeToken: first.body.challengeToken, code: lastCode() })).status).toBe(401);

    const again = await login(user, cookie);
    expect(again.body.accessToken).toBeTruthy();
    expect(again.body.twoFactorRequired).toBeUndefined();
  });

  it('authenticator: set up with a confirmed code, then asked at sign-in', async () => {
    const user = await registerAndActivate();
    const setup = await request(app).post('/api/v1/auth/two-factor/totp/setup').set(bearer(user)).send({ password: user.password });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const counter = Math.floor(Date.now() / 30000);
    const confirm = await request(app).post('/api/v1/auth/two-factor/totp/confirm').set(bearer(user)).send({ code: totpAt(setup.body.secret, counter) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.mode).toBe('totp');
    const row = await db.UserTwoFactor.findByPk(user.userId);
    expect(row.totpSecretSealed).not.toContain(setup.body.secret);

    const challenge = await login(user);
    expect(challenge.body).toMatchObject({ twoFactorRequired: true, channel: 'totp' });
    const done = await verify({ challengeToken: challenge.body.challengeToken, code: totpAt(setup.body.secret, Math.floor(Date.now() / 30000)) });
    expect(done.status).toBe(200);
    expect(done.body.accessToken).toBeTruthy();
  });

  it('backup codes: shown once, each finishes one sign-in', async () => {
    const user = await registerAndActivate();
    await request(app).post('/api/v1/auth/two-factor/email/enable').set(bearer(user)).send({ password: user.password }).expect(200);
    const made = await request(app).post('/api/v1/auth/two-factor/backup-codes').set(bearer(user)).send({ password: user.password });
    expect(made.status).toBe(201);
    expect(made.body.codes).toHaveLength(10);
    const [backup] = made.body.codes;

    const challenge = await login(user);
    const done = await verify({ challengeToken: challenge.body.challengeToken, code: backup });
    expect(done.status).toBe(200);
    const status = await request(app).get('/api/v1/auth/two-factor').set(bearer(user));
    expect(status.body.backupCodesLeft).toBe(9);

    const second = await login(user);
    expect((await verify({ challengeToken: second.body.challengeToken, code: backup })).status).toBe(401);
  });

  it('an account gets at most 10 wrong codes in 15 minutes, over all its sign-ins', async () => {
    const user = await registerAndActivate();
    await request(app).post('/api/v1/auth/two-factor/email/enable').set(bearer(user)).send({ password: user.password }).expect(200);
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const challenge = await login(user);
      for (let k = 0; k < 4; k += 1) statuses.push((await verify({ challengeToken: challenge.body.challengeToken, code: '111111' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('the console can turn it off for a person who lost every way through (support.manage)', async () => {
    const user = await registerAndActivate();
    await request(app).post('/api/v1/auth/two-factor/email/enable').set(bearer(user)).send({ password: user.password }).expect(200);
    const admin = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['overview.view', 'support.manage'] }, { where: { id: admin.userId } });
    const res = await request(app).post(`/api/v1/admin/users/${user.userId}/two-factor/reset`).set(admin.H);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'off', previousMode: 'email' });
    expect((await db.UserTwoFactor.findByPk(user.userId)).mode).toBe('off');
    expect((await request(app).get('/api/v1/auth/me').set(bearer(user))).status).toBe(401);
    const plain = await login(user);
    expect(plain.body.accessToken).toBeTruthy();
  });

  it('the console reset follows the rule for an account above the actor', async () => {
    const above = await makePlatformUser('admin');
    await request(app).post('/api/v1/auth/two-factor/email/enable').set(above.H).send({ password: above.password }).expect(200);
    await db.User.update({ platformPermissions: ['plans.manage', 'support.manage'] }, { where: { id: above.userId } });
    const manager = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['support.manage', 'admins.manage'] }, { where: { id: manager.userId } });

    const res = await request(app).post(`/api/v1/admin/users/${above.userId}/two-factor/reset`).set(manager.H);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_NOT_HELD');
    expect((await db.UserTwoFactor.findByPk(above.userId)).mode).toBe('email');

    const creator = await makePlatformUser('creator');
    expect((await request(app).post(`/api/v1/admin/users/${above.userId}/two-factor/reset`).set(creator.H)).status).toBe(200);
    expect((await db.UserTwoFactor.findByPk(above.userId)).mode).toBe('off');
  });
});

describe('the new-device code (NEW_DEVICE_CODE)', () => {
  it('asks a browser new to the account for an email code, then knows it', async () => {
    env.newDevice.code = true;
    const user = await registerAndActivate();
    const first = await login(user);
    expect(first.body).toMatchObject({ twoFactorRequired: true, channel: 'email', newDevice: true });

    const done = await verify({ challengeToken: first.body.challengeToken, code: lastCode() });
    expect(done.status).toBe(200);
    const known = done.headers['set-cookie'].find((c) => c.startsWith('zimos_known')).split(';')[0];

    const again = await login(user, known);
    expect(again.body.accessToken).toBeTruthy();
  });
});
