'use strict';

// Sign-up codes — REQUIRE_SIGNUP_VERIFICATION (auth/signupPolicy,
// otp/verificationCodeService): no tokens until a 6-digit code sent by email
// or SMS is typed back; the code's own rules; the limits on sending; and that
// the code never leaks.

jest.mock('../../src/modules/auth/googleClient', () => ({
  getAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
  fetchProfile: jest.fn(),
}));
const googleClient = require('../../src/modules/auth/googleClient');

const { app, request, uniqueEmail, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const logger = require('../../src/core/utils/logger');
const codes = require('../../src/modules/otp/verificationCodeService');

const ORIGINAL_SIGNUP = { ...env.signup, smsCountryCodes: [...env.signup.smsCountryCodes] };
const ORIGINAL_NOTIFICATIONS = JSON.parse(JSON.stringify(env.notifications));
const ORIGINAL_PRODUCTION = env.isProduction;

let outbox = [];
beforeEach(() => {
  env.signup.requireVerification = true;
  outbox = [];
  jest.spyOn(notify, 'email').mockImplementation(async (opts) => {
    outbox.push({ channel: 'email', ...opts });
    return { status: 'sent' };
  });
  jest.spyOn(notify, 'sms').mockImplementation(async (opts) => {
    outbox.push({ channel: 'sms', ...opts });
    return { status: 'sent' };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.assign(env.signup, ORIGINAL_SIGNUP, { smsCountryCodes: [...ORIGINAL_SIGNUP.smsCountryCodes] });
  Object.assign(env.notifications, JSON.parse(JSON.stringify(ORIGINAL_NOTIFICATIONS)));
  env.isProduction = ORIGINAL_PRODUCTION;
  googleClient.fetchProfile.mockReset();
});

const PASSWORD = 'Passw0rd!123';
const register = (overrides = {}) =>
  request(app)
    .post('/api/v1/auth/register')
    .send({ phone: '01012345678', email: uniqueEmail('code'), password: PASSWORD, fullName: 'Code Person', ...overrides });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const send = (token, body = {}) => request(app).post('/api/v1/auth/verify/send').set(bearer(token)).send(body);
const confirm = (token, code) => request(app).post('/api/v1/auth/verify/confirm').set(bearer(token)).send({ code });
const lastCode = () => outbox[outbox.length - 1].data.code;
const wrongCode = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');
// Moves every code the account was sent a minute and a bit into the past,
// past the 60-second wait between two codes.
const pastCooldown = (userId) =>
  db.sequelize.query(`UPDATE verification_codes SET created_at = created_at - interval '61 seconds' WHERE user_id = $id`, {
    bind: { id: userId },
  });
const userOf = async (email) => db.User.findOne({ where: { email } });
const newestUser = () => db.User.findOne({ order: [['createdAt', 'DESC']] });
// An account made the way they were before the switch was turned on.
async function existingAccount() {
  env.signup.requireVerification = false;
  try {
    return await registerAndActivate();
  } finally {
    env.signup.requireVerification = true;
  }
}

describe('with REQUIRE_SIGNUP_VERIFICATION off', () => {
  it('signs up and in at once — tokens back, the account active, a code emailed to confirm it, no link', async () => {
    env.signup.requireVerification = false;
    const email = uniqueEmail('soft');
    const res = await register({ email, locale: 'en' });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.verificationRequired).toBeUndefined();
    expect(res.body.user).toMatchObject({ status: 'active', emailVerifiedAt: null });
    expect(res.body.emailCode).toMatchObject({ sent: true, target: `${email[0]}***@example.com` });
    expect(outbox.map((m) => m.template)).toEqual(['signup_code']);
    expect(await db.VerificationCode.count({ where: { userId: res.body.user.id } })).toBe(1);

    const me = await request(app).get('/api/v1/auth/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.confirmed).toBe(false);
  });
});

describe('sign-up with a code', () => {
  it('answers with a verification step instead of tokens, and emails a code', async () => {
    const email = uniqueEmail('first');
    const res = await register({ email, locale: 'en' });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).not.toHaveProperty('refreshToken');
    // Every sign-up has a phone now, so SMS is offered beside email; the code goes by email.
    expect(res.body).toMatchObject({ verificationRequired: true, channels: ['email', 'sms'], codeSent: true, channel: 'email' });
    expect(res.body.targets).toMatchObject({ email: `${email[0]}***@example.com` });
    expect(res.body.verificationToken).toBeTruthy();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ channel: 'email', recipient: email, template: 'signup_code' });
    expect(outbox[0].data).toMatchObject({ minutes: 10, locale: 'en' });
    expect(lastCode()).toMatch(/^\d{6}$/);
    expect((await userOf(email)).status).toBe('pending_verification');
  });

  it('offers the phone too, masked, when the account has one', async () => {
    const res = await register({ phone: '01012345234' });
    expect(res.body.channels).toEqual(['email', 'sms']);
    // Every digit but the first two and the last three hidden.
    expect(res.body.targets.sms).toBe('01******234');
  });

  it('signs in at once on the right code, confirming the email', async () => {
    const email = uniqueEmail('right');
    const reg = await register({ email });
    const res = await confirm(reg.body.verificationToken, lastCode());
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.status).toBe('active');
    expect(res.body.user.emailVerifiedAt).toBeTruthy();
    expect(res.body.user.phoneVerifiedAt).toBeNull();
    const me = await request(app).get('/api/v1/auth/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
  });

  it('counts wrong codes and kills the code after the fifth', async () => {
    const reg = await register();
    const token = reg.body.verificationToken;
    const right = lastCode();
    for (let left = 4; left >= 1; left -= 1) {
      const res = await confirm(token, wrongCode(right));
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'INVALID_CODE', details: { attemptsLeft: left } });
    }
    const fifth = await confirm(token, wrongCode(right));
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    // Dead even for the right code now.
    const late = await confirm(token, right);
    expect(late.status).toBe(429);
    expect(late.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('refuses an expired code', async () => {
    const reg = await register();
    await db.VerificationCode.update({ expiresAt: new Date(Date.now() - 1000) }, { where: {} });
    const res = await confirm(reg.body.verificationToken, lastCode());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CODE_EXPIRED');
  });

  it('expires a code ten minutes after it was sent', async () => {
    await register();
    const row = await db.VerificationCode.findOne();
    const ttl = new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime();
    expect(Math.abs(ttl - 10 * 60 * 1000)).toBeLessThan(2000);
  });

  it('uses a code once', async () => {
    const reg = await register();
    const code = lastCode();
    expect((await confirm(reg.body.verificationToken, code)).status).toBe(200);
    const again = await confirm(reg.body.verificationToken, code);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_VERIFIED');
    expect((await db.VerificationCode.findOne()).consumedAt).toBeTruthy();
  });

  it('makes the resend wait 60 seconds, and a new code replaces the old one', async () => {
    const reg = await register();
    const token = reg.body.verificationToken;
    const first = lastCode();
    const soon = await send(token);
    expect(soon.status).toBe(429);
    expect(soon.body.error.code).toBe('RESEND_TOO_SOON');
    expect(soon.body.error.details.retryAfterSeconds).toBeGreaterThan(50);

    const user = await db.User.findOne({ where: { status: 'pending_verification' } });
    await pastCooldown(user.id);
    const resent = await send(token, { channel: 'email' });
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ sent: true, channel: 'email' });
    expect(new Date(resent.body.resendAvailableAt).getTime() - Date.now()).toBeGreaterThan(55 * 1000);
    const second = lastCode();
    if (second !== first) {
      expect((await confirm(token, first)).body.error.code).toBe('INVALID_CODE');
    }
    expect((await confirm(token, second)).status).toBe(200);
  });

  it('sends by SMS to the account’s own phone and confirms the phone', async () => {
    const reg = await register({ phone: '01012345678', locale: 'ar' });
    const user = await db.User.findOne({ where: { status: 'pending_verification' } });
    await pastCooldown(user.id);
    const res = await send(reg.body.verificationToken, { channel: 'sms', locale: 'ar' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ channel: 'sms', target: '01******678' });
    expect(outbox[outbox.length - 1]).toMatchObject({ channel: 'sms', recipient: '201012345678' });
    expect(outbox[outbox.length - 1].data).toMatchObject({ minutes: 10, locale: 'ar' });

    const done = await confirm(reg.body.verificationToken, lastCode());
    expect(done.status).toBe(200);
    expect(done.body.user.phoneVerifiedAt).toBeTruthy();
    expect(done.body.user.emailVerifiedAt).toBeNull();
    expect(done.body.user.status).toBe('active');
  });

  it('hides SMS when Twilio is not set up', async () => {
    env.notifications.smsProvider = 'twilio';
    env.notifications.twilio = { accountSid: '', authToken: '', fromNumber: '' };
    const reg = await register({ phone: '01012345678' });
    expect(reg.body.channels).toEqual(['email']);
    expect(reg.body.targets).not.toHaveProperty('sms');
    const user = await db.User.findOne({ where: { status: 'pending_verification' } });
    await pastCooldown(user.id);
    const res = await send(reg.body.verificationToken, { channel: 'sms' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHANNEL_NOT_AVAILABLE');
  });

  it('only texts the allowed country codes (Egypt unless configured)', async () => {
    const abroad = await register({ phone: '+447700900123' });
    expect(abroad.body.channels).toEqual(['email']);
    env.signup.smsCountryCodes = ['20', '44'];
    const allowed = await register({ phone: '+447700900124' });
    expect(allowed.body.channels).toEqual(['email', 'sms']);
  });

  it('refuses a fourth SMS to one account in a day', async () => {
    const reg = await register({ phone: '01012345678' });
    const user = await db.User.findOne({ where: { status: 'pending_verification' } });
    for (let i = 0; i < codes.LIMITS.smsPerAccountPerDay; i += 1) {
      await pastCooldown(user.id);
      expect((await send(reg.body.verificationToken, { channel: 'sms' })).status).toBe(200);
    }
    await pastCooldown(user.id);
    const res = await send(reg.body.verificationToken, { channel: 'sms' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('VERIFICATION_LIMIT_REACHED');
    // Email still works.
    await pastCooldown(user.id);
    expect((await send(reg.body.verificationToken, { channel: 'email' })).status).toBe(200);
  });

  it('caps SMS from one IP in a day, across accounts', async () => {
    for (let i = 0; i < codes.LIMITS.smsPerIpPerDay; i += 1) {
      const reg = await register({ phone: `0101000000${i}` });
      await pastCooldown((await newestUser()).id);
      expect((await send(reg.body.verificationToken, { channel: 'sms' })).status).toBe(200);
    }
    const reg = await register({ phone: '01010000099' });
    await pastCooldown((await newestUser()).id);
    const res = await send(reg.body.verificationToken, { channel: 'sms' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('VERIFICATION_LIMIT_REACHED');
  });

  it('caps codes to one address in an hour', async () => {
    const reg = await register();
    const user = await db.User.findOne({ where: { status: 'pending_verification' } });
    for (let i = 1; i < codes.LIMITS.targetPerHour; i += 1) {
      await pastCooldown(user.id);
      expect((await send(reg.body.verificationToken)).status).toBe(200);
    }
    await pastCooldown(user.id);
    const res = await send(reg.body.verificationToken);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('VERIFICATION_LIMIT_REACHED');
  });

  it('caps codes from one IP in an hour, before an account is even made', async () => {
    // The client's address comes from X-Forwarded-For (`trust proxy` = 1), so it
    // is the same on every host: the socket's own address is 127.0.0.1 on an
    // IPv4-only one and ::ffff:127.0.0.1 on a dual-stack one.
    const ip = '203.0.113.7';
    const rows = [];
    for (let i = 0; i < codes.LIMITS.ipPerHour; i += 1) {
      rows.push({ userId: null, channel: 'email', target: `x${i}@example.com`, codeHash: 'x', expiresAt: new Date(), requestIp: ip });
    }
    const owner = await existingAccount();
    await db.VerificationCode.bulkCreate(rows.map((r) => ({ ...r, userId: owner.userId })));
    const before = await db.User.count();
    const res = await register().set('X-Forwarded-For', ip);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('VERIFICATION_LIMIT_REACHED');
    expect(await db.User.count()).toBe(before);
  });

  it('refuses to start a sign-up when no email can be sent (fail closed)', async () => {
    env.notifications.emailProvider = 'brevo';
    env.notifications.brevo = { apiKey: '', fromAddress: '', fromName: 'Zimos' };
    const before = await db.User.count();
    const res = await register();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SIGNUP_UNAVAILABLE');
    expect(await db.User.count()).toBe(before);
  });

  it('treats the console provider as no provider in production', () => {
    env.isProduction = true;
    expect(codes.emailReady()).toBe(false);
    expect(codes.smsReady()).toBe(false);
  });
});

describe('signing in', () => {
  it('sends an unconfirmed account to its code instead of in', async () => {
    const email = uniqueEmail('later');
    await register({ email });
    const user = await userOf(email);
    await pastCooldown(user.id);
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).toMatchObject({ verificationRequired: true, codeSent: true });
    expect((await confirm(res.body.verificationToken, lastCode())).status).toBe(200);
  });

  it('answers a wrong password the same whether or not the account exists or is confirmed', async () => {
    const email = uniqueEmail('enum');
    await register({ email });
    const unconfirmed = await request(app).post('/api/v1/auth/login').send({ email, password: 'Wrong0ne!x' });
    const missing = await request(app).post('/api/v1/auth/login').send({ email: uniqueEmail('nobody'), password: 'Wrong0ne!x' });
    expect(unconfirmed.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(unconfirmed.body.error.code).toBe(missing.body.error.code);
    expect(unconfirmed.body.error.message).toBe(missing.body.error.message);
  });

  it('lets an account that was already confirmed in, as before', async () => {
    const existing = await existingAccount();
    const res = await request(app).post('/api/v1/auth/login').send({ email: existing.email, password: existing.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('never asks a Google account for a code', async () => {
    googleClient.fetchProfile.mockResolvedValueOnce({ googleId: 'g-77', email: uniqueEmail('g'), emailVerified: true, fullName: 'G' });
    const res = await require('../helpers/googleSignIn').googleCallback('code=x');
    const token = new URL(res.headers.location, 'http://x').searchParams.get('accessToken');
    expect(token).toBeTruthy();
    expect((await request(app).get('/api/v1/auth/me').set(bearer(token))).status).toBe(200);
    expect(outbox).toHaveLength(0);
  });
});

describe('the verification token', () => {
  it('opens the two code endpoints and nothing else', async () => {
    const reg = await register();
    const token = reg.body.verificationToken;
    for (const [method, path] of [
      ['get', '/api/v1/auth/me'],
      ['get', '/api/v1/workspaces'],
      ['post', '/api/v1/workspaces'],
      ['get', '/api/v1/auth/sessions'],
    ]) {
      const res = await request(app)[method](path).set(bearer(token)).send({ name: 'Nope' });
      expect(res.status).toBe(401);
    }
    const refresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: token });
    expect(refresh.status).toBe(401);
  });

  it('is not an access token, and an access token is not one', async () => {
    const active = await existingAccount();
    const res = await send(active.accessToken);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('VERIFICATION_TOKEN_INVALID');
  });
});

describe('the code never leaks', () => {
  it('is in no response, audit entry or production log line', async () => {
    env.isProduction = true;
    // The console provider would refuse to count in production; stand in for Brevo.
    env.notifications.emailProvider = 'brevo';
    env.notifications.brevo = { apiKey: 'k', fromAddress: 'noreply@zimos.test', fromName: 'Zimos' };
    jest.restoreAllMocks();
    const brevo = require('../../src/modules/notifications/brevoEmailProvider');
    const sentMail = [];
    jest.spyOn(brevo, 'sendEmail').mockImplementation(async (mail) => {
      sentMail.push(mail);
      return { attempts: 1 };
    });
    const lines = [];
    for (const level of ['info', 'warn', 'error', 'debug']) {
      jest.spyOn(logger, level).mockImplementation((message, meta) => lines.push(JSON.stringify([message, meta])));
    }

    const reg = await register({ locale: 'ar' });
    expect(reg.status).toBe(201);
    const code = sentMail[0].text.match(/\d{6}/)[0];
    expect(sentMail[0].subject).not.toContain(code);
    expect(sentMail[0].html).not.toMatch(/<a\s/i);
    expect(sentMail[0].text).toMatch(/10/);

    const bad = await confirm(reg.body.verificationToken, wrongCode(code));
    const good = await confirm(reg.body.verificationToken, code);
    expect(good.status).toBe(200);

    for (const body of [reg.body, bad.body, good.body]) expect(JSON.stringify(body)).not.toContain(code);
    const audits = await db.AuditLog.findAll({ where: { action: ['auth.verify.send', 'auth.verify.fail', 'auth.verify.confirm'] } });
    expect(audits.map((a) => a.action).sort()).toEqual(['auth.verify.confirm', 'auth.verify.fail', 'auth.verify.send']);
    expect(JSON.stringify(audits.map((a) => a.toJSON()))).not.toContain(code);
    expect(lines.join('\n')).not.toContain(code);
    const stored = await db.VerificationCode.findOne();
    expect(stored.codeHash).not.toContain(code);
  });

  it('redacts the code when the console provider logs in production', async () => {
    jest.restoreAllMocks();
    env.isProduction = true;
    const lines = [];
    jest.spyOn(logger, 'info').mockImplementation((message, meta) => lines.push(JSON.stringify([message, meta])));
    await notify.sms({ recipient: '201000000000', template: 'otp_signup_verification', data: { code: '424242' } });
    await notify.email({ recipient: 'a@example.com', template: 'signup_code', data: { code: '434343', locale: 'en' } });
    expect(lines.join('\n')).not.toMatch(/424242|434343/);
    expect(lines.join('\n')).toContain('[REDACTED]');
  });
});
