'use strict';

// How long a sign-in lasts (SESSION_TTL_DAYS, SESSION_TTL_DAYS_CONSOLE), what
// "sign out of all devices" ends, what a replayed refresh token records, and
// the two switches REFRESH_REUSE_ROTATED_ONLY and
// TWO_FACTOR_CHANGE_ENDS_SESSIONS (both off unless a test sets them).

const { app, request, registerAndActivate, setPlatformRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const DAY_MS = 24 * 60 * 60 * 1000;
const loaded = { ...env.session };

afterEach(() => {
  Object.assign(env.session, loaded);
  env.twoFactor.enabled = false;
});

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const me = (token) => request(app).get('/api/v1/auth/me').set(bearer(token));
const refresh = (refreshToken) => request(app).post('/api/v1/auth/refresh').send({ refreshToken });
const login = (u) => request(app).post('/api/v1/auth/login').send({ email: u.email, password: u.password });
const signOutEverywhere = (token) => request(app).post('/api/v1/auth/sessions/revoke-all').set(bearer(token));
const audits = (action) => db.AuditLog.findAll({ where: { action }, order: [['createdAt', 'ASC']] });
const daysLeft = (expiresAt) => (new Date(expiresAt).getTime() - Date.now()) / DAY_MS;
// Signing up may open a session of its own beside the sign-in's: counted, not assumed.
const liveSessions = (userId) => db.Session.count({ where: { userId, revokedAt: null } });

/** A second device on the same account: its own session and tokens. */
async function secondDevice(user) {
  const res = await login(user);
  expect(res.status).toBe(200);
  return res.body;
}

describe('how long a sign-in lasts', () => {
  /** env.session as the app would read it at start with these variables. */
  function sessionConfig(vars) {
    const saved = {};
    for (const [name, value] of Object.entries(vars)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    let session;
    try {
      jest.isolateModules(() => {
        session = require('../../src/config/env').session;
      });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    return session;
  }

  it('unset: 30 days for everyone, as before', () => {
    expect(sessionConfig({ SESSION_TTL_DAYS: '', SESSION_TTL_DAYS_CONSOLE: '' })).toMatchObject({ ttlDays: 30, consoleTtlDays: 30 });
  });

  it('a whole number of days from 1 to 365 is taken; anything else is 30', () => {
    expect(sessionConfig({ SESSION_TTL_DAYS: '90', SESSION_TTL_DAYS_CONSOLE: '7' })).toMatchObject({ ttlDays: 90, consoleTtlDays: 7 });
    expect(sessionConfig({ SESSION_TTL_DAYS: '90', SESSION_TTL_DAYS_CONSOLE: '' })).toMatchObject({ ttlDays: 90, consoleTtlDays: 30 });
    for (const bad of ['0', '-5', '366', '1.5', '90d', 'abc']) {
      expect(sessionConfig({ SESSION_TTL_DAYS: bad, SESSION_TTL_DAYS_CONSOLE: bad })).toMatchObject({ ttlDays: 30, consoleTtlDays: 30 });
    }
  });

  it('the two switches are off under the test suite whatever the environment says', () => {
    const session = sessionConfig({ REFRESH_REUSE_ROTATED_ONLY: 'true', TWO_FACTOR_CHANGE_ENDS_SESSIONS: 'true' });
    expect(session).toMatchObject({ reuseRotatedOnly: false, endOthersOnTwoFactorChange: false });
  });

  it('30 days from the sign-in, and 30 again from a refresh', async () => {
    env.session.ttlDays = 30;
    const user = await registerAndActivate();
    expect(daysLeft(user.expiresAt)).toBeGreaterThan(29.99);
    expect(daysLeft(user.expiresAt)).toBeLessThan(30.01);

    const refreshed = await refresh(user.refreshToken);
    expect(refreshed.status).toBe(200);
    expect(daysLeft(refreshed.body.expiresAt)).toBeGreaterThan(29.99);
    expect(daysLeft(refreshed.body.expiresAt)).toBeLessThan(30.01);
  });

  it('SESSION_TTL_DAYS=90: a sign-in and every refresh get 90 days; set back, the next refresh gets 30', async () => {
    env.session.ttlDays = 90;
    const user = await registerAndActivate();
    expect(daysLeft(user.expiresAt)).toBeGreaterThan(89.99);
    expect(daysLeft(user.expiresAt)).toBeLessThan(90.01);
    const row = await db.Session.findByPk(user.sessionId);
    expect(daysLeft(row.expiresAt)).toBeGreaterThan(89.99);

    const refreshed = await refresh(user.refreshToken);
    expect(refreshed.status).toBe(200);
    expect(daysLeft(refreshed.body.expiresAt)).toBeGreaterThan(89.99);
    expect(daysLeft(refreshed.body.expiresAt)).toBeLessThan(90.01);

    env.session.ttlDays = 30;
    const back = await refresh(refreshed.body.refreshToken);
    expect(back.status).toBe(200);
    expect(daysLeft(back.body.expiresAt)).toBeLessThan(30.01);
  });

  it('an account with a platform role gets the console length, at sign-in and at a refresh', async () => {
    env.session.ttlDays = 90;
    env.session.consoleTtlDays = 30;
    // Signed in before it held a role: the store length.
    const user = await registerAndActivate();
    expect(daysLeft(user.expiresAt)).toBeGreaterThan(89.99);

    await setPlatformRole(user.userId, 'admin');
    const refreshed = await refresh(user.refreshToken);
    expect(refreshed.status).toBe(200);
    expect(daysLeft(refreshed.body.expiresAt)).toBeGreaterThan(29.99);
    expect(daysLeft(refreshed.body.expiresAt)).toBeLessThan(30.01);

    const again = await login(user);
    expect(again.status).toBe(200);
    expect(daysLeft(again.body.expiresAt)).toBeLessThan(30.01);
  });

  it('a session past its date is refused, and the access token it gave out with it', async () => {
    const user = await registerAndActivate();
    await db.Session.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: user.sessionId } });

    const res = await refresh(user.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_EXPIRED');
    expect((await me(user.accessToken)).status).toBe(401);
  });
});

describe('sign out of all devices', () => {
  it('ends every session of the account: no refresh token works and every access token answers 401 at once', async () => {
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    expect((await me(laptop.accessToken)).status).toBe(200);
    expect((await me(phone.accessToken)).status).toBe(200);

    expect((await signOutEverywhere(laptop.accessToken)).status).toBe(200);

    for (const device of [laptop, phone]) {
      const old = await me(device.accessToken);
      expect(old.status).toBe(401);
      expect(old.body.error.code).toBe('SESSION_ENDED');
    }
    expect(await db.Session.count({ where: { userId: laptop.userId, revokedAt: null } })).toBe(0);
    expect((await refresh(laptop.refreshToken)).status).toBe(401);
    expect((await refresh(phone.refreshToken)).status).toBe(401);
  });

  it('leaves another account alone, and the account can sign in again', async () => {
    const user = await registerAndActivate();
    const other = await registerAndActivate();
    expect((await signOutEverywhere(user.accessToken)).status).toBe(200);

    expect((await me(other.accessToken)).status).toBe(200);
    expect((await refresh(other.refreshToken)).status).toBe(200);

    const again = await login(user);
    expect(again.status).toBe(200);
    expect((await me(again.body.accessToken)).status).toBe(200);
  });

  it('forgets the browsers remembered for the second step and closes a sign-in waiting for its code', async () => {
    const user = await registerAndActivate();
    const other = await registerAndActivate();
    const soon = new Date(Date.now() + 60 * 1000);
    await db.TrustedDevice.create({ userId: user.userId, deviceHash: 'a'.repeat(64), expiresAt: soon });
    await db.TrustedDevice.create({ userId: other.userId, deviceHash: 'b'.repeat(64), expiresAt: soon });
    const waiting = await db.LoginChallenge.create({ userId: user.userId, channel: 'email', expiresAt: soon });
    const othersWaiting = await db.LoginChallenge.create({ userId: other.userId, channel: 'email', expiresAt: soon });
    const live = await liveSessions(user.userId);
    expect(live).toBeGreaterThan(0);

    expect((await signOutEverywhere(user.accessToken)).status).toBe(200);

    expect(await db.TrustedDevice.count({ where: { userId: user.userId } })).toBe(0);
    expect(await db.TrustedDevice.count({ where: { userId: other.userId } })).toBe(1);
    expect((await waiting.reload()).consumedAt).not.toBeNull();
    expect((await othersWaiting.reload()).consumedAt).toBeNull();

    const [audit] = await audits('user.revoke_all_sessions');
    expect(audit.actorUserId).toBe(user.userId);
    expect(audit.metadata).toEqual({ sessionsRevoked: live, devicesForgotten: 1, challengesClosed: 1 });
  });

  it('needs a signed-in account', async () => {
    expect((await request(app).post('/api/v1/auth/sessions/revoke-all')).status).toBe(401);
  });
});

describe('one refresh token presented twice at the same moment', () => {
  const { Op } = db.Sequelize;
  const allSessions = (userId) => db.Session.count({ where: { userId } });
  const rotatedAway = (userId) => db.Session.findAll({ where: { userId, rotatedToSessionId: { [Op.ne]: null } } });

  // A race, so several rounds: any round showing two new sessions is the fault.
  it('makes one new session; the other request is a reuse, and no session is left', async () => {
    for (let round = 0; round < 5; round += 1) {
      const laptop = await registerAndActivate();
      // The account already has the session its sign-up opened beside the
      // sign-in's (liveSessions, above), so what is there is counted first.
      const before = await allSessions(laptop.userId);
      const [a, b] = await Promise.all([refresh(laptop.refreshToken), refresh(laptop.refreshToken)]);
      expect([a.status, b.status].sort()).toEqual([200, 401]);
      const refused = a.status === 401 ? a : b;
      expect(refused.body.error.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');
      // The reuse ended every session, the one just made included.
      expect(await liveSessions(laptop.userId)).toBe(0);
      const accepted = a.status === 200 ? a : b;
      expect((await me(accepted.body.accessToken)).status).toBe(401);
      // One session was made, not two, and the token's own session points at it.
      expect(await allSessions(laptop.userId)).toBe(before + 1);
      const rotated = await rotatedAway(laptop.userId);
      expect(rotated).toHaveLength(1);
      expect(rotated[0].rotatedToSessionId).toBe(accepted.body.sessionId);
    }
  });

  it('on its own, a refresh still rotates as before', async () => {
    const laptop = await registerAndActivate();
    const sessionsBefore = await allSessions(laptop.userId);
    const liveBefore = await liveSessions(laptop.userId);
    const rotated = await refresh(laptop.refreshToken);
    expect(rotated.status).toBe(200);
    expect((await me(rotated.body.accessToken)).status).toBe(200);

    // One session ended and one was made in its place: as many live as before,
    // and the account's other session is left as it was.
    expect(await allSessions(laptop.userId)).toBe(sessionsBefore + 1);
    expect(await liveSessions(laptop.userId)).toBe(liveBefore);
    const ended = await db.Session.findAll({ where: { userId: laptop.userId, revokedAt: { [Op.ne]: null } } });
    expect(ended).toHaveLength(1);
    expect(ended[0].rotatedToSessionId).toBe(rotated.body.sessionId);
    expect((await db.Session.findByPk(rotated.body.sessionId)).revokedAt).toBeNull();
  });
});

describe('a refresh token presented a second time', () => {
  it('rotated away: every session ends and it is recorded once, with what it ended', async () => {
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    const rotated = await refresh(laptop.refreshToken);
    expect(rotated.status).toBe(200);
    const live = await liveSessions(laptop.userId);
    expect(live).toBeGreaterThanOrEqual(2);

    const replay = await refresh(laptop.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');
    expect((await me(rotated.body.accessToken)).status).toBe(401);
    expect((await me(phone.accessToken)).status).toBe(401);

    const rows = await audits('user.refresh_reuse_detected');
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(laptop.userId);
    expect(rows[0].metadata).toMatchObject({ sessionsRevoked: live, rotated: true });
    expect(rows[0].metadata.tokenEndedSecondsAgo).toBeGreaterThanOrEqual(0);
    expect(rows[0].metadata.tokenEndedSecondsAgo).toBeLessThan(60);

    // Nothing is left to end: presenting it again adds no row.
    expect((await refresh(laptop.refreshToken)).status).toBe(401);
    expect(await audits('user.refresh_reuse_detected')).toHaveLength(1);
  });

  it('switch off (the default): the token of a session ended on purpose ends the other sessions too, as before', async () => {
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: laptop.refreshToken }).expect(200);
    const live = await liveSessions(laptop.userId);
    expect(live).toBeGreaterThanOrEqual(1);

    const res = await refresh(laptop.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');
    expect((await me(phone.accessToken)).status).toBe(401);

    const [audit] = await audits('user.refresh_reuse_detected');
    expect(audit.metadata).toMatchObject({ sessionsRevoked: live, rotated: false });
  });

  it('REFRESH_REUSE_ROTATED_ONLY: the token of a session ended on purpose is refused alone', async () => {
    env.session.reuseRotatedOnly = true;
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: laptop.refreshToken }).expect(200);

    const res = await refresh(laptop.refreshToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_ENDED');

    expect((await me(phone.accessToken)).status).toBe(200);
    expect((await refresh(phone.refreshToken)).status).toBe(200);
    expect(await audits('user.refresh_reuse_detected')).toHaveLength(0);
  });

  it('REFRESH_REUSE_ROTATED_ONLY: after signing out of all devices, a device waking up does not end the new sign-in', async () => {
    env.session.reuseRotatedOnly = true;
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    expect((await signOutEverywhere(laptop.accessToken)).status).toBe(200);
    const again = await secondDevice(laptop);

    expect((await refresh(phone.refreshToken)).status).toBe(401);
    expect((await me(again.accessToken)).status).toBe(200);
    expect((await refresh(again.refreshToken)).status).toBe(200);
  });

  it('REFRESH_REUSE_ROTATED_ONLY: a rotated token still ends every session', async () => {
    env.session.reuseRotatedOnly = true;
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    const rotated = await refresh(laptop.refreshToken);

    const replay = await refresh(laptop.refreshToken);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');
    expect((await me(rotated.body.accessToken)).status).toBe(401);
    expect((await me(phone.accessToken)).status).toBe(401);
  });
});

describe('turning the second step on or off', () => {
  const enableEmail = (u, token = u.accessToken) =>
    request(app).post('/api/v1/auth/two-factor/email/enable').set(bearer(token)).send({ password: u.password });
  const disable = (u, token = u.accessToken) =>
    request(app).post('/api/v1/auth/two-factor/disable').set(bearer(token)).send({ password: u.password });

  beforeEach(() => {
    env.twoFactor.enabled = true;
  });

  it('switch off (the default): the other devices stay signed in', async () => {
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);

    expect((await enableEmail(laptop)).status).toBe(200);
    expect((await me(phone.accessToken)).status).toBe(200);
    expect((await disable(laptop)).status).toBe(200);
    expect((await me(phone.accessToken)).status).toBe(200);
    expect((await refresh(phone.refreshToken)).status).toBe(200);
    expect(await audits('user.other_sessions_ended')).toHaveLength(0);
  });

  it('TWO_FACTOR_CHANGE_ENDS_SESSIONS: turning it on ends the other devices and keeps this one', async () => {
    env.session.endOthersOnTwoFactorChange = true;
    env.session.reuseRotatedOnly = true;
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    const tablet = await secondDevice(laptop);
    const live = await liveSessions(laptop.userId);

    const on = await enableEmail(laptop);
    expect(on.status).toBe(200);
    expect(on.body.mode).toBe('email');

    for (const device of [phone, tablet]) {
      const old = await me(device.accessToken);
      expect(old.status).toBe(401);
      expect(old.body.error.code).toBe('SESSION_ENDED');
      expect((await refresh(device.refreshToken)).status).toBe(401);
    }
    expect((await me(laptop.accessToken)).status).toBe(200);
    expect((await refresh(laptop.refreshToken)).status).toBe(200);

    const [audit] = await audits('user.other_sessions_ended');
    expect(audit.actorUserId).toBe(laptop.userId);
    // Every live session but the laptop's own.
    expect(audit.metadata).toEqual({ reason: 'two_factor_change', sessionsEnded: live - 1 });
    expect(await liveSessions(laptop.userId)).toBe(1);
  });

  it('TWO_FACTOR_CHANGE_ENDS_SESSIONS: turning it off does the same', async () => {
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    // Turned on while the switch is still off: the phone stays.
    expect((await enableEmail(laptop)).status).toBe(200);
    expect((await me(phone.accessToken)).status).toBe(200);

    env.session.endOthersOnTwoFactorChange = true;
    const off = await disable(laptop);
    expect(off.status).toBe(200);
    expect(off.body.mode).toBe('off');

    expect((await me(phone.accessToken)).status).toBe(401);
    expect((await me(laptop.accessToken)).status).toBe(200);
  });

  it('TWO_FACTOR_CHANGE_ENDS_SESSIONS: this device is kept when its access token is from before its last refresh', async () => {
    env.session.endOthersOnTwoFactorChange = true;
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);
    // The laptop refreshed; a request still in flight carries the access token from before.
    const refreshed = await refresh(laptop.refreshToken);
    expect(refreshed.status).toBe(200);

    expect((await enableEmail(laptop, laptop.accessToken)).status).toBe(200);

    expect((await me(phone.accessToken)).status).toBe(401);
    expect((await me(refreshed.body.accessToken)).status).toBe(200);
    expect((await refresh(refreshed.body.refreshToken)).status).toBe(200);
  });

  it('TWO_FACTOR_CHANGE_ENDS_SESSIONS: a wrong password changes nothing and ends nothing', async () => {
    env.session.endOthersOnTwoFactorChange = true;
    const laptop = await registerAndActivate();
    const phone = await secondDevice(laptop);

    const res = await request(app).post('/api/v1/auth/two-factor/email/enable').set(bearer(laptop.accessToken)).send({ password: 'not-it' });
    expect(res.status).toBe(422);
    expect((await me(phone.accessToken)).status).toBe(200);
  });
});
