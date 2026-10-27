'use strict';

// Mock the Google profile fetch so no real consent flow is needed. Hoisted
// above the app require by Jest.
jest.mock('../../src/modules/auth/googleClient', () => ({
  getAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
  fetchProfile: jest.fn(),
}));
const googleClient = require('../../src/modules/auth/googleClient');

const { app, request } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { hashPassword } = require('../../src/core/security/password');
const { signAccessToken } = require('../../src/core/security/tokens');

beforeEach(() => googleClient.fetchProfile.mockReset());

function query(location) {
  const u = new URL(location, 'http://placeholder');
  return {
    base: u.origin + u.pathname,
    accessToken: u.searchParams.get('accessToken'),
    refreshToken: u.searchParams.get('refreshToken'),
    error: u.searchParams.get('error'),
  };
}

// Through GET /auth/google first, as a browser does (the OAuth state).
const { googleCallback: callback } = require('../helpers/googleSignIn');

describe('Google OAuth login', () => {
  it('GET /auth/google redirects the browser to the Google consent screen', async () => {
    const res = await request(app).get('/api/v1/auth/google').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/accounts\.google\.com/);
  });

  it('a first Google login creates an active user with a googleId and no password', async () => {
    googleClient.fetchProfile.mockResolvedValueOnce({
      googleId: 'g-1001',
      email: 'newby@example.com',
      emailVerified: true,
      fullName: 'New Person',
    });

    const res = await callback('code=fake-auth-code');
    expect(res.status).toBe(302);

    const q = query(res.headers.location);
    expect(q.base).toBe(`${env.frontendUrl}/auth/callback`);
    expect(q.accessToken).toBeTruthy();
    expect(q.refreshToken).toBeTruthy();

    const user = await db.User.findOne({ where: { email: 'newby@example.com' } });
    expect(user).not.toBeNull();
    expect(user.googleId).toBe('g-1001');
    expect(user.passwordHash).toBeNull();
    expect(user.status).toBe('active');
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await db.User.count({ where: { email: 'newby@example.com' } })).toBe(1);

    // the issued access token actually works
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${q.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('newby@example.com');
  });

  it('a second Google login with the same googleId logs into the same account, no duplicate', async () => {
    googleClient.fetchProfile.mockResolvedValue({
      googleId: 'g-2002',
      email: 'repeat@example.com',
      emailVerified: true,
      fullName: 'Repeat User',
    });

    await callback('code=first');
    const first = await db.User.findOne({ where: { googleId: 'g-2002' } });

    await callback('code=second');
    const all = await db.User.findAll({ where: { googleId: 'g-2002' } });

    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
  });

  it('Google login with an email matching an existing confirmed password account links instead of duplicating', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ phone: '01012345678', email: 'existing@example.com', password: 'Passw0rd!123', fullName: 'Existing User' });
    expect(reg.status).toBe(201);
    // Its owner confirmed the email: the password is theirs and stays.
    await db.User.update({ emailVerifiedAt: new Date() }, { where: { email: 'existing@example.com' } });

    const before = await db.User.findOne({ where: { email: 'existing@example.com' } });
    expect(before.googleId).toBeNull();
    expect(before.passwordHash).toBeTruthy();

    googleClient.fetchProfile.mockResolvedValueOnce({
      googleId: 'g-3003',
      email: 'existing@example.com',
      emailVerified: true,
      fullName: 'Existing User',
    });

    const res = await callback('code=link-code');
    expect(res.status).toBe(302);
    expect(query(res.headers.location).accessToken).toBeTruthy();

    const after = await db.User.findAll({ where: { email: 'existing@example.com' } });
    expect(after).toHaveLength(1); // linked, not duplicated
    expect(after[0].id).toBe(before.id);
    expect(after[0].googleId).toBe('g-3003');
    expect(after[0].passwordHash).toBe(before.passwordHash); // password still there — both methods now work
  });

  it('Google login on an unconfirmed password account with that email takes it over: no password, no old sessions', async () => {
    // Anyone can sign up with an address they don't own; it stays unconfirmed.
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ phone: '01012345678', email: 'squatted@example.com', password: 'Passw0rd!123', fullName: 'Not The Owner' });
    expect(reg.status).toBe(201);
    const before = await db.User.findOne({ where: { email: 'squatted@example.com' } });
    expect(before.emailVerifiedAt).toBeNull();
    expect(before.phoneVerifiedAt).toBeNull();

    // The address's owner signs in with Google.
    googleClient.fetchProfile.mockResolvedValueOnce({
      googleId: 'g-5005',
      email: 'squatted@example.com',
      emailVerified: true,
      fullName: 'The Owner',
    });
    const res = await callback('code=takeover-code');
    expect(res.status).toBe(302);
    const q = query(res.headers.location);

    const after = await db.User.findByPk(before.id);
    expect(after.googleId).toBe('g-5005');
    expect(after.passwordHash).toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await db.Session.count({ where: { userId: before.id, revokedAt: null } })).toBe(1); // the Google one

    const audit = await db.AuditLog.findOne({ where: { action: 'user.link.google', entityId: before.id } });
    // The second step it may have set up goes too (nothing here: 2FA was never on).
    expect(audit.metadata).toEqual({ unconfirmedAccount: true, passwordRemoved: true, sessionsRevoked: 1, devicesForgotten: 0, challengesClosed: 0, twoFactorReset: false });

    // The owner's Google session works.
    expect((await request(app).get('/api/v1/workspaces').set('Authorization', `Bearer ${q.accessToken}`)).status).toBe(200);

    // The old password and the old refresh token don't.
    const oldPassword = await request(app).post('/api/v1/auth/login').send({ identifier: 'squatted@example.com', password: 'Passw0rd!123' });
    expect(oldPassword.status).toBe(401);
    expect(oldPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    const oldRefresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: reg.body.refreshToken });
    expect(oldRefresh.status).toBe(401);
  });

  it('Google login on a pending_verification password account activates it and its tokens reach protected routes', async () => {
    // An account from before soft confirmation, still `pending_verification`
    // with no verified email (new sign-ups are active at once).
    const before = await db.User.create({
      email: 'pending-google@example.com',
      passwordHash: await hashPassword('Passw0rd!123'),
      fullName: 'Pending Person',
      status: 'pending_verification',
    });
    expect(before.emailVerifiedAt).toBeNull();

    // While pending, its tokens are locked out of protected routes.
    const lockedOut = await request(app)
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${signAccessToken({ sub: before.id })}`);
    expect(lockedOut.status).toBe(401);

    // Now the same person signs in with Google using the same email address.
    googleClient.fetchProfile.mockResolvedValueOnce({
      googleId: 'g-4004',
      email: 'pending-google@example.com',
      emailVerified: true,
      fullName: 'Pending Person',
    });

    const res = await callback('code=activate-code');
    expect(res.status).toBe(302);
    const q = query(res.headers.location);
    expect(q.accessToken).toBeTruthy();
    expect(q.refreshToken).toBeTruthy();

    // The account is now active and email-verified — not stuck as pending.
    const after = await db.User.findAll({ where: { email: 'pending-google@example.com' } });
    expect(after).toHaveLength(1); // linked, not duplicated
    expect(after[0].id).toBe(before.id);
    expect(after[0].googleId).toBe('g-4004');
    expect(after[0].status).toBe('active');
    expect(after[0].emailVerifiedAt).not.toBeNull();
    // Never confirmed, so it may not have been the Google owner's: the password goes.
    expect(after[0].passwordHash).toBeNull();

    // And the tokens from that Google login can immediately hit a protected route.
    const ws = await request(app)
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${q.accessToken}`);
    expect(ws.status).toBe(200);
    expect(Array.isArray(ws.body.workspaces)).toBe(true);
  });

  it('a Google denial (?error=access_denied) redirects to the frontend with the error, no user created', async () => {
    const res = await callback('error=access_denied');
    expect(res.status).toBe(302);
    expect(query(res.headers.location).error).toBe('access_denied');
    expect(await db.User.count()).toBe(0);
  });
});

describe("Google sign-in and the account's status", () => {
  const PASSWORD = 'Passw0rd!123';
  const authService = require('../../src/modules/auth/authService');

  async function account(email, fields) {
    const user = await db.User.create({ email, passwordHash: await hashPassword(PASSWORD), fullName: 'Status Person', ...fields });
    // A session from before, to see that nothing touches it.
    await db.Session.create({
      userId: user.id,
      refreshTokenHash: require('crypto').randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return user;
  }
  const googleProfile = (googleId, email) =>
    googleClient.fetchProfile.mockResolvedValue({ googleId, email, emailVerified: true, fullName: 'Status Person' });

  it('a suspended account not linked to Google is refused and left exactly as it was', async () => {
    const before = await account('suspended@example.com', { status: 'suspended' });
    googleProfile('g-6006', 'suspended@example.com');

    const res = await callback('code=suspended-code');
    expect(res.status).toBe(302);
    const q = query(res.headers.location);
    expect(q.error).toBe('ACCOUNT_SUSPENDED');
    expect(q.accessToken).toBeNull();

    const after = await db.User.findByPk(before.id);
    expect(after.status).toBe('suspended');
    expect(after.googleId).toBeNull();
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.emailVerifiedAt).toBeNull();
    expect(await db.Session.count({ where: { userId: before.id, revokedAt: null } })).toBe(1);
    expect(await db.AuditLog.count({ where: { action: 'user.link.google', entityId: before.id } })).toBe(0);

    // The same refusal as a password sign-in: same code, same message.
    const byPassword = await request(app).post('/api/v1/auth/login').send({ identifier: 'suspended@example.com', password: PASSWORD });
    expect(byPassword.status).toBe(401);
    await expect(authService.loginWithGoogle('suspended-code', null)).rejects.toMatchObject({
      code: byPassword.body.error.code,
      message: byPassword.body.error.message,
    });
    expect(byPassword.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('a suspended account already linked to Google is refused too', async () => {
    const before = await account('suspended-linked@example.com', { status: 'suspended', googleId: 'g-7007', emailVerifiedAt: new Date() });
    googleProfile('g-7007', 'suspended-linked@example.com');

    const res = await callback('code=suspended-linked-code');
    expect(query(res.headers.location).error).toBe('ACCOUNT_SUSPENDED');
    expect((await db.User.findByPk(before.id)).status).toBe('suspended');
    expect(await db.Session.count({ where: { userId: before.id } })).toBe(1); // no new session
  });

  it('a pending account is activated and linked, as before', async () => {
    const before = await account('pending-status@example.com', { status: 'pending_verification' });
    googleProfile('g-8008', 'pending-status@example.com');

    const q = query((await callback('code=pending-status-code')).headers.location);
    expect(q.accessToken).toBeTruthy();
    const after = await db.User.findByPk(before.id);
    expect(after).toMatchObject({ status: 'active', googleId: 'g-8008' });
  });

  it('an active account is linked and signed in, still active', async () => {
    const before = await account('active-status@example.com', { status: 'active', emailVerifiedAt: new Date() });
    googleProfile('g-9009', 'active-status@example.com');

    const q = query((await callback('code=active-status-code')).headers.location);
    expect(q.accessToken).toBeTruthy();
    const after = await db.User.findByPk(before.id);
    expect(after).toMatchObject({ status: 'active', googleId: 'g-9009' });
    expect(after.passwordHash).toBe(before.passwordHash); // confirmed: keeps its password
  });
});

describe('Google sign-in: state and verified email', () => {
  it('GET /auth/google puts a random state in an httpOnly cookie and in the URL it builds', async () => {
    const res = await request(app).get('/api/v1/auth/google').redirects(0);
    const cookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('zimos_gstate'));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const state = cookie.split(';')[0].split('=')[1];
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    expect(googleClient.getAuthUrl).toHaveBeenLastCalledWith(state);
  });

  it('a callback the browser did not start (no state cookie) is refused before Google is asked', async () => {
    googleClient.fetchProfile.mockResolvedValue({ googleId: 'g-csrf', email: 'csrf@example.com', emailVerified: true, fullName: 'X' });
    const res = await request(app).get('/api/v1/auth/google/callback?code=attacker-code&state=abc').redirects(0);
    expect(res.status).toBe(302);
    const q = query(res.headers.location);
    expect(q.error).toBe('GOOGLE_STATE_MISMATCH');
    expect(q.accessToken).toBeNull();
    expect(googleClient.fetchProfile).not.toHaveBeenCalled();
    expect(await db.User.count()).toBe(0);
  });

  it('a state that does not match the cookie is refused', async () => {
    const start = await request(app).get('/api/v1/auth/google').redirects(0);
    const pair = start.headers['set-cookie'].find((c) => c.startsWith('zimos_gstate')).split(';')[0];
    const res = await request(app)
      .get(`/api/v1/auth/google/callback?code=x&state=${'0'.repeat(64)}`)
      .set('Cookie', pair)
      .redirects(0);
    expect(query(res.headers.location).error).toBe('GOOGLE_STATE_MISMATCH');
  });

  it('a Google account whose email is not verified neither creates nor links an account', async () => {
    const before = await db.User.create({ email: 'owner@example.com', passwordHash: await hashPassword('Passw0rd!123'), fullName: 'O', status: 'active', emailVerifiedAt: new Date() });
    googleClient.fetchProfile.mockResolvedValue({ googleId: 'g-unverified', email: 'owner@example.com', emailVerified: false, fullName: 'Not Owner' });

    const res = await callback('code=unverified');
    expect(query(res.headers.location).error).toBe('GOOGLE_EMAIL_UNVERIFIED');
    expect((await db.User.findByPk(before.id)).googleId).toBeNull();

    googleClient.fetchProfile.mockResolvedValue({ googleId: 'g-unverified-2', email: 'nobody@example.com', emailVerified: false, fullName: 'N' });
    const res2 = await callback('code=unverified-2');
    expect(query(res2.headers.location).error).toBe('GOOGLE_EMAIL_UNVERIFIED');
    expect(await db.User.count({ where: { email: 'nobody@example.com' } })).toBe(0);
  });

  it('a code Google refuses comes back as GOOGLE_LOGIN_FAILED, not a server error', async () => {
    googleClient.fetchProfile.mockRejectedValue(new Error('invalid_grant'));
    const res = await callback('code=expired');
    expect(res.status).toBe(302);
    expect(query(res.headers.location).error).toBe('GOOGLE_LOGIN_FAILED');
  });
});

describe('Google sign-in and two-step sign-in', () => {
  afterEach(() => {
    env.twoFactor.enabled = false;
  });

  it("asks for the account's own second step, through the callback's redirect", async () => {
    env.twoFactor.enabled = true;
    const user = await db.User.create({ email: 'twostep@example.com', googleId: 'g-2fa', fullName: 'Two Step', status: 'active', emailVerifiedAt: new Date() });
    await db.UserTwoFactor.create({ userId: user.id, mode: 'email', enabledAt: new Date() });
    googleClient.fetchProfile.mockResolvedValue({ googleId: 'g-2fa', email: 'twostep@example.com', emailVerified: true, fullName: 'Two Step' });

    const res = await callback('code=two-step');
    const u = new URL(res.headers.location, 'http://placeholder');
    expect(u.searchParams.get('twoFactorRequired')).toBe('true');
    expect(u.searchParams.get('challengeToken')).toBeTruthy();
    expect(u.searchParams.get('accessToken')).toBeNull();
  });
});

describe('Google sign-up and the console\'s "New sign-up"', () => {
  const { QueryTypes } = require('sequelize');
  const signups = (userId) =>
    db.sequelize.query("SELECT * FROM platform_notifications WHERE type = 'user_signup' AND subject_user_id = :userId", {
      replacements: { userId },
      type: QueryTypes.SELECT,
    });

  it('a new account tells the console once, as a password sign-up does; signing in again does not', async () => {
    googleClient.fetchProfile.mockResolvedValue({ googleId: 'g-console', email: 'console@example.com', emailVerified: true, fullName: 'Console Person' });
    await callback('code=first');
    const user = await db.User.findOne({ where: { googleId: 'g-console' } });

    const [row, ...more] = await signups(user.id);
    expect(more).toHaveLength(0);
    expect(row).toMatchObject({ title: 'New sign-up', link: `/users/${user.id}` });
    expect(row.data).toMatchObject({ action: 'user.register.google' });

    await callback('code=second');
    expect(await signups(user.id)).toHaveLength(1);
  });

  it('linking Google to an account that already exists is not a sign-up', async () => {
    const user = await db.User.create({ email: 'linked@example.com', passwordHash: await hashPassword('Passw0rd!123'), fullName: 'L', status: 'active', emailVerifiedAt: new Date() });
    googleClient.fetchProfile.mockResolvedValue({ googleId: 'g-linked', email: 'linked@example.com', emailVerified: true, fullName: 'L' });

    await callback('code=link');
    expect((await db.User.findByPk(user.id)).googleId).toBe('g-linked');
    expect(await signups(user.id)).toHaveLength(0);
  });

  it('a Google sign-up audited before the change does not turn into one later', async () => {
    // Only a new audit entry makes the row (platformNotificationService.onAudit);
    // the console's one schedule reads subscriptions, not the audit log.
    const user = await db.User.create({ email: 'earlier@example.com', googleId: 'g-earlier', fullName: 'E', status: 'active', emailVerifiedAt: new Date() });
    await db.AuditLog.create({ actorUserId: user.id, action: 'user.register.google', entityType: 'User', entityId: user.id });

    await require('../../src/modules/platformAdmin/platformNotificationService').sweepSubscriptions();
    expect(await signups(user.id)).toHaveLength(0);
  });
});
