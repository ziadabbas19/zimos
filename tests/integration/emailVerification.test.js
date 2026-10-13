'use strict';

// Email verification end to end: the POST /auth/verify-email endpoint that
// flips a `pending_verification` account to `active`, and the
// POST /auth/resend-verification endpoint that re-issues the token.
//
// New sign-ups no longer get a link (they are active at once and get a code,
// see signupVerification.test.js); these endpoints stay for the accounts and
// links from before, so the pending accounts here are made directly.

const { app, request, uniqueEmail } = require('../helpers/factories');
const db = require('../../src/db/models');
const notify = require('../../src/modules/notifications/notify');
const env = require('../../src/config/env');
const { hashPassword } = require('../../src/core/security/password');

const ORIGINAL_PROVIDER = env.notifications.emailProvider;

let emailSpy;
beforeEach(() => {
  // `console` provider just logs — no network — and the spy captures the
  // opaque token that would have gone out in the email.
  env.notifications.emailProvider = 'console';
  emailSpy = jest.spyOn(notify, 'email');
});
afterEach(() => emailSpy.mockRestore());
afterAll(() => {
  env.notifications.emailProvider = ORIGINAL_PROVIDER;
});

const tokenFromEmail = (template) => {
  const call = [...emailSpy.mock.calls].reverse().find((c) => c[0].template === template);
  return call && call[0].data.token;
};

// An account from before soft confirmation, still pending, with its link.
async function registerPending(email = uniqueEmail()) {
  const user = await db.User.create({
    email,
    passwordHash: await hashPassword('Passw0rd!123'),
    fullName: 'Pending User',
    status: 'pending_verification',
  });
  await request(app).post('/api/v1/auth/resend-verification').send({ email }).expect(200);
  return { email, userId: user.id, token: tokenFromEmail('email_verification') };
}

describe('POST /auth/verify-email', () => {
  it('flips status to active and sets emailVerifiedAt for a valid token', async () => {
    const { userId, token } = await registerPending();
    expect((await db.User.findByPk(userId)).status).toBe('pending_verification');

    const res = await request(app).post('/api/v1/auth/verify-email').send({ token });

    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('active');
    expect(res.body.user.emailVerifiedAt).toBeTruthy();
    expect(res.body.user.passwordHash).toBeUndefined();

    const row = await db.User.findByPk(userId);
    expect(row.status).toBe('active');
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('rejects a token that was already used (single-use)', async () => {
    const { token } = await registerPending();
    await request(app).post('/api/v1/auth/verify-email').send({ token }).expect(200);

    const second = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
  });

  it('rejects an expired token', async () => {
    const { userId, token } = await registerPending();
    await db.VerificationToken.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { userId, type: 'email_verification' } }
    );

    const res = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
    expect((await db.User.findByPk(userId)).status).toBe('pending_verification');
  });

  it('rejects a garbage token', async () => {
    const res = await request(app).post('/api/v1/auth/verify-email').send({ token: 'not-a-real-token' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
  });

  it('does not lift a suspension: a link sent before it confirms the address and nothing else', async () => {
    const { email, userId, token } = await registerPending();
    // What the console's suspend writes on the account (userModerationService).
    await db.User.update({ status: 'suspended', suspendedAt: new Date(), suspendedReason: 'Fraud reports' }, { where: { id: userId } });

    const res = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.user.status).toBe('suspended');

    const row = await db.User.findByPk(userId);
    expect(row.status).toBe('suspended');
    expect(row.suspendedAt).toBeInstanceOf(Date);
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);

    const signIn = await request(app).post('/api/v1/auth/login').send({ email, password: 'Passw0rd!123' });
    expect(signIn.status).toBe(401);
    expect(signIn.body.error.code).toBe('ACCOUNT_SUSPENDED');

    // The link is spent all the same.
    const again = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(again.status).toBe(400);
  });

  it('refuses the link of a deleted account and changes nothing', async () => {
    const { userId, token } = await registerPending();
    await db.User.update({ status: 'suspended', deletedAt: new Date() }, { where: { id: userId } });

    const res = await request(app).post('/api/v1/auth/verify-email').send({ token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
    const row = await db.User.findByPk(userId);
    expect(row.status).toBe('suspended');
    expect(row.emailVerifiedAt).toBeNull();
  });
});

describe('POST /auth/resend-verification', () => {
  it('is enumeration-safe: unknown email returns 200 and sends nothing', async () => {
    emailSpy.mockClear();
    const res = await request(app)
      .post('/api/v1/auth/resend-verification')
      .send({ email: uniqueEmail('nobody') });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(emailSpy.mock.calls.some((c) => c[0].template === 'email_verification')).toBe(false);
  });

  it('re-sends a fresh token and invalidates the previous one for a pending account', async () => {
    const { email, userId, token: firstToken } = await registerPending();
    emailSpy.mockClear();

    const res = await request(app).post('/api/v1/auth/resend-verification').send({ email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const secondToken = tokenFromEmail('email_verification');
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    // The original link no longer works...
    const stale = await request(app).post('/api/v1/auth/verify-email').send({ token: firstToken });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');

    // ...but the freshly-mailed one does.
    const ok = await request(app).post('/api/v1/auth/verify-email').send({ token: secondToken });
    expect(ok.status).toBe(200);
    expect((await db.User.findByPk(userId)).status).toBe('active');
  });

  it('returns success but sends nothing for an already-verified account', async () => {
    const { email, token } = await registerPending();
    await request(app).post('/api/v1/auth/verify-email').send({ token }).expect(200);
    emailSpy.mockClear();

    const res = await request(app).post('/api/v1/auth/resend-verification').send({ email });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(emailSpy.mock.calls.some((c) => c[0].template === 'email_verification')).toBe(false);
  });

  it('rejects a missing/invalid email with 422', async () => {
    const res = await request(app).post('/api/v1/auth/resend-verification').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
