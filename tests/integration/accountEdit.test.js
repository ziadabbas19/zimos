'use strict';

// A signed-in person changing their own account (auth/accountService):
//
//   PATCH /auth/me/name
//   PATCH /auth/me/username                 (usernameService)
//   POST  /auth/me/reauth-code              an account without a password
//   POST  /auth/me/email-change, /confirm
//   POST  /auth/me/phone-change, /confirm   PHONE_CHANGE_ENABLED
//
// Codes are read from what notify was asked to send, never from the database
// (only a digest is stored).

const { app, request, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const codes = require('../../src/modules/otp/verificationCodeService');
const { render } = require('../../src/modules/notifications/emailTemplates');

const PASSWORD = 'Passw0rd!123';
const auth = (who) => ({ Authorization: `Bearer ${who.accessToken}` });

let emailSpy;
let smsSpy;
beforeEach(() => {
  emailSpy = jest.spyOn(notify, 'email');
  smsSpy = jest.spyOn(notify, 'sms');
});
afterEach(() => {
  emailSpy.mockRestore();
  smsSpy.mockRestore();
  env.account.phoneChangeEnabled = false;
});

async function sentTo(spy, recipient, template) {
  await codes.settleAccountCodeDeliveries();
  const calls = spy.mock.calls.map(([arg]) => arg).filter((a) => a.recipient === recipient && (!template || a.template === template));
  return calls.length ? calls[calls.length - 1].data.code : null;
}

const requestEmail = (who, body) => request(app).post('/api/v1/auth/me/email-change').set(auth(who)).send(body);
const confirmEmail = (who, code) => request(app).post('/api/v1/auth/me/email-change/confirm').set(auth(who)).send({ code });

describe('the name', () => {
  it('changes freely, validated and audited, for the signed-in account only', async () => {
    const a = await registerAndActivate({ fullName: 'Mona Adel' });
    const b = await registerAndActivate({ fullName: 'Hany Samir' });
    const res = await request(app).patch('/api/v1/auth/me/name').set(auth(a)).send({ fullName: '  Mona   Adel Hassan ' });
    expect(res.status).toBe(200);
    expect(res.body.user.fullName).toBe('Mona Adel Hassan');
    expect((await db.User.findByPk(b.userId)).fullName).toBe('Hany Samir');
    const audit = await db.AuditLog.findOne({ where: { action: 'user.name.change' } });
    expect(audit).toMatchObject({ actorUserId: a.userId, entityId: a.userId });
    expect(audit.afterState).toEqual({ fullName: 'Mona Adel Hassan' });

    for (const fullName of ['M', 'x'.repeat(201), '   ']) {
      const bad = await request(app).patch('/api/v1/auth/me/name').set(auth(a)).send({ fullName });
      expect(bad.status).toBe(422);
    }
  });
});

describe('the username', () => {
  it('is taken whatever the case, and two accounts asking for one at once get it once', async () => {
    const a = await registerAndActivate();
    const b = await registerAndActivate();
    const c = await registerAndActivate();
    await db.User.update({ usernameChangedAt: null }, { where: {} });
    const holder = await db.User.findByPk(c.userId);
    const taken = await request(app).patch('/api/v1/auth/me/username').set(auth(a)).send({ username: holder.username.toUpperCase() });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('USERNAME_TAKEN');

    const [ra, rb] = await Promise.all([
      request(app).patch('/api/v1/auth/me/username').set(auth(a)).send({ username: 'nile_store' }),
      request(app).patch('/api/v1/auth/me/username').set(auth(b)).send({ username: 'Nile_Store' }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(await db.User.count({ where: db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('username')), 'nile_store') })).toBe(1);
  });
});

describe('the email', () => {
  it('needs the current password; a wrong one changes and sends nothing', async () => {
    const a = await registerAndActivate();
    const res = await requestEmail(a, { newEmail: 'new.address@example.com', currentPassword: 'wrong-password' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_PASSWORD');
    const missing = await requestEmail(a, { newEmail: 'new.address@example.com' });
    expect(missing.status).toBe(422);
    expect(await db.VerificationCode.count({ where: { purpose: 'email_change' } })).toBe(0);
    expect(await sentTo(emailSpy, 'new.address@example.com')).toBeNull();
  });

  it('changes only once the code sent to the new email comes back, ending every other session', async () => {
    const a = await registerAndActivate({ fullName: 'Mona Adel' });
    const second = await request(app).post('/api/v1/auth/login').send({ email: a.email, password: PASSWORD });
    const oldEmail = a.email;

    const asked = await requestEmail(a, { newEmail: 'Mona.New@Example.com', currentPassword: PASSWORD, locale: 'en' });
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ sent: true, channel: 'email', target: 'm***@example.com' });
    expect((await db.User.findByPk(a.userId)).email).toBe(oldEmail);
    const code = await sentTo(emailSpy, 'mona.new@example.com', 'email_change_code');
    expect(code).toMatch(/^\d{6}$/);

    // Another account can't use it.
    const b = await registerAndActivate();
    expect((await confirmEmail(b, code)).body.error.code).toBe('NO_ACTIVE_CODE');

    const done = await confirmEmail(a, code);
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ email: 'mona.new@example.com' });
    expect(done.body.user.emailVerifiedAt).toBeTruthy();

    // The new session works; every earlier one is over. (Presenting a revoked
    // token revokes every session — the existing reuse detection — so the
    // new one is checked first.)
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: done.body.refreshToken })).status).toBe(200);
    expect(await db.Session.count({ where: { userId: a.userId, revokedAt: null } })).toBe(1);
    for (const refreshToken of [a.refreshToken, second.body.refreshToken]) {
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken })).status).toBe(401);
    }
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'mona.new@example.com', password: PASSWORD })).status).toBe(200);

    // The old address is told, with no link.
    await new Promise((resolve) => setImmediate(resolve));
    const notice = emailSpy.mock.calls.map(([x]) => x).find((x) => x.recipient === oldEmail && x.template === 'email_changed');
    expect(notice.data.newEmailMasked).toBe('m***@example.com');
    const rendered = render('email_changed', notice.data);
    expect(rendered.html).not.toMatch(/href|https?:\/\//);
    expect(rendered.text).toMatch(/Zimos/);
    expect(rendered.html).toMatch(/dir="rtl"/);

    const audit = await db.AuditLog.findOne({ where: { action: 'user.email.change' } });
    expect(audit.beforeState).toEqual({ email: `${oldEmail[0]}***@example.com` });
    expect(audit.afterState).toEqual({ email: 'm***@example.com' });
    expect(audit.metadata.sessionsRevoked).toBeGreaterThanOrEqual(2);
  });

  it('answers an email another account holds the same way, and sends nothing to it', async () => {
    const a = await registerAndActivate();
    const holder = await registerAndActivate();
    const free = await requestEmail(a, { newEmail: 'free.one@example.com', currentPassword: PASSWORD });
    await db.VerificationCode.update({ createdAt: new Date(Date.now() - 120000) }, { where: { userId: a.userId } });
    const taken = await requestEmail(a, { newEmail: holder.email, currentPassword: PASSWORD });

    expect(taken.status).toBe(free.status);
    expect(Object.keys(taken.body).sort()).toEqual(Object.keys(free.body).sort());
    expect(await sentTo(emailSpy, holder.email, 'email_change_code')).toBeNull();
    // A guess behaves exactly as for a code that was sent.
    const guess = await confirmEmail(a, '000000');
    expect(guess.status).toBe(422);
    expect(guess.body.error.code).toBe('INVALID_CODE');
    expect((await db.User.findByPk(a.userId)).email).toBe(a.email);
  });

  it('a code expires, and five wrong guesses kill it', async () => {
    const a = await registerAndActivate();
    await requestEmail(a, { newEmail: 'later@example.com', currentPassword: PASSWORD });
    const code = await sentTo(emailSpy, 'later@example.com');
    await db.VerificationCode.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { userId: a.userId, purpose: 'email_change' } });
    expect((await confirmEmail(a, code)).body.error.code).toBe('CODE_EXPIRED');

    await db.VerificationCode.update({ createdAt: new Date(Date.now() - 120000) }, { where: { userId: a.userId } });
    await requestEmail(a, { newEmail: 'later@example.com', currentPassword: PASSWORD });
    const fresh = await sentTo(emailSpy, 'later@example.com');
    const wrong = fresh === '111111' ? '222222' : '111111';
    for (let i = 0; i < 4; i += 1) expect((await confirmEmail(a, wrong)).body.error.code).toBe('INVALID_CODE');
    expect((await confirmEmail(a, wrong)).status).toBe(429);
    expect((await confirmEmail(a, fresh)).status).toBe(429);
    expect((await db.User.findByPk(a.userId)).email).toBe(a.email);
  });

  it('kills a password reset link still out for the old address', async () => {
    const a = await registerAndActivate();
    await request(app).post('/api/v1/auth/password-reset/request').send({ email: a.email });
    const authService = require('../../src/modules/auth/authService');
    await authService.settlePasswordResets();
    expect(await db.VerificationToken.count({ where: { userId: a.userId, type: 'password_reset', usedAt: null } })).toBe(1);

    await requestEmail(a, { newEmail: 'moved@example.com', currentPassword: PASSWORD });
    await confirmEmail(a, await sentTo(emailSpy, 'moved@example.com'));
    expect(await db.VerificationToken.count({ where: { userId: a.userId, type: 'password_reset', usedAt: null } })).toBe(0);
  });

  it('its codes are limited per account only and never count toward the sign-up limits', async () => {
    const a = await registerAndActivate();
    await requestEmail(a, { newEmail: 'counted@example.com', currentPassword: PASSWORD });
    const row = await db.VerificationCode.findOne({ where: { userId: a.userId, purpose: 'email_change' } });
    expect(row.requestIp).toBeNull();
    // Six more to the same address, past the sign-up limit per address (5 an hour).
    for (let i = 0; i < 6; i += 1) {
      await db.VerificationCode.create({ userId: a.userId, channel: 'email', target: 'counted@example.com', codeHash: 'x', expiresAt: new Date(), purpose: 'email_change', requestIp: '9.9.9.9' });
    }
    await expect(codes.assertCanSend({ channel: 'email', target: 'counted@example.com', ip: '9.9.9.9' })).resolves.toBeUndefined();
    // And its own limit: a second request inside the minute.
    const soon = await requestEmail(a, { newEmail: 'counted@example.com', currentPassword: PASSWORD });
    expect(soon.status).toBe(429);
    expect(soon.body.error.code).toBe('RESEND_TOO_SOON');
  });
});

describe('an account made through Google (no password)', () => {
  async function googleAccount() {
    const who = await registerAndActivate({ fullName: 'Google Person' });
    await db.User.update({ passwordHash: null, googleId: `g-${who.userId}` }, { where: { id: who.userId } });
    return who;
  }

  it('proves itself with a code to its current email, then changes it; Google stays linked', async () => {
    const g = await googleAccount();
    const without = await requestEmail(g, { newEmail: 'g.new@example.com' });
    expect(without.status).toBe(422);
    expect(without.body.error.code).toBe('REAUTH_CODE_REQUIRED');

    const sent = await request(app).post('/api/v1/auth/me/reauth-code').set(auth(g)).send({ locale: 'en' });
    expect(sent.status).toBe(200);
    const reauth = await sentTo(emailSpy, g.email.toLowerCase(), 'account_reauth_code');
    expect(reauth).toMatch(/^\d{6}$/);

    const asked = await requestEmail(g, { newEmail: 'g.new@example.com', reauthCode: reauth });
    expect(asked.status).toBe(200);
    const done = await confirmEmail(g, await sentTo(emailSpy, 'g.new@example.com', 'email_change_code'));
    expect(done.status).toBe(200);
    expect(await db.User.findByPk(g.userId)).toMatchObject({ email: 'g.new@example.com', googleId: `g-${g.userId}` });
  });

  it('a password account confirms with its password, not a code', async () => {
    const a = await registerAndActivate();
    const res = await request(app).post('/api/v1/auth/me/reauth-code').set(auth(a)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PASSWORD_REQUIRED');
  });
});

describe('the phone (PHONE_CHANGE_ENABLED)', () => {
  const requestPhone = (who, body) => request(app).post('/api/v1/auth/me/phone-change').set(auth(who)).send(body);

  it('off: the same answer to any request, nothing sent, nothing kept', async () => {
    const a = await registerAndActivate();
    const good = await requestPhone(a, { newPhone: '01012345678', currentPassword: PASSWORD });
    const wrongPassword = await requestPhone(a, { newPhone: '01112345678', currentPassword: 'nope' });
    for (const res of [good, wrongPassword]) {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sent: true, channel: 'sms' });
    }
    expect(smsSpy).not.toHaveBeenCalled();
    expect(await db.VerificationCode.count({ where: { purpose: 'phone_change' } })).toBe(0);
    const confirm = await request(app).post('/api/v1/auth/me/phone-change/confirm').set(auth(a)).send({ code: '123456' });
    expect(confirm.body.error.code).toBe('NO_ACTIVE_CODE');
  });

  it('on: a code by SMS to the new number, normalised; the code changes it', async () => {
    env.account.phoneChangeEnabled = true;
    // registerAndActivate signs up with 01012345678, so the new number must differ.
    const a = await registerAndActivate();
    const res = await requestPhone(a, { newPhone: '0102 345 6789', currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.target).toBe('01******789');
    const code = await sentTo(smsSpy, '201023456789');
    expect(code).toMatch(/^\d{6}$/);
    const done = await request(app).post('/api/v1/auth/me/phone-change/confirm').set(auth(a)).send({ code });
    expect(done.status).toBe(200);
    expect(await db.User.findByPk(a.userId)).toMatchObject({ phone: '201023456789' });
    expect((await db.User.findByPk(a.userId)).phoneVerifiedAt).toBeTruthy();

    const wrong = await requestPhone(a, { newPhone: '01112345678', currentPassword: 'nope' });
    expect(wrong.body.error.code).toBe('INVALID_PASSWORD');
  });
});

describe('/auth/me', () => {
  it('says how changes are confirmed and whether the phone can change', async () => {
    const a = await registerAndActivate();
    const res = await request(app).get('/api/v1/auth/me').set(auth(a));
    expect(res.body.account).toEqual({ hasPassword: true, phoneChange: false });
  });
});
