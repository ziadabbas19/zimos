'use strict';

// The email "forgot password" flow end to end through the notification
// pipeline (Brevo adapter mocked). The token in the email is the one that
// resets the password; it's single-use and time-limited; and the request is
// enumeration-safe.

jest.mock('../../src/modules/notifications/brevoEmailProvider', () => ({
  sendEmail: jest.fn().mockResolvedValue({ messageId: 'brevo-mock' }),
  buildPayload: jest.requireActual('../../src/modules/notifications/brevoEmailProvider').buildPayload,
  BREVO_ENDPOINT: 'https://api.brevo.com/v3/smtp/email',
}));

const brevo = require('../../src/modules/notifications/brevoEmailProvider');
const notify = require('../../src/modules/notifications/notify');
const emailTemplates = require('../../src/modules/notifications/emailTemplates');
const { app, request, registerAndActivate, uniqueEmail } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const ORIGINAL_PROVIDER = env.notifications.emailProvider;

let emailSpy;
beforeEach(() => {
  brevo.sendEmail.mockClear();
  env.notifications.emailProvider = 'brevo';
  env.notifications.brevo.apiKey = 'test-key';
  env.notifications.brevo.fromAddress = 'store@example.com';
  emailSpy = jest.spyOn(notify, 'email');
});
afterEach(() => emailSpy.mockRestore());
afterAll(() => {
  env.notifications.emailProvider = ORIGINAL_PROVIDER;
});

const tokenFromEmail = () => {
  const call = emailSpy.mock.calls.find((c) => c[0].template === 'password_reset');
  return call[0].data.token;
};

describe('email forgot-password end to end', () => {
  it('sends a password_reset email whose token resets the password and revokes sessions', async () => {
    const auth = await registerAndActivate();
    brevo.sendEmail.mockClear();
    emailSpy.mockClear();

    const reqRes = await request(app).post('/api/v1/auth/password-reset/request').send({ email: auth.email });
    expect(reqRes.status).toBe(200);

    // the Brevo adapter got the reset email, with the token link + spam footer
    expect(brevo.sendEmail).toHaveBeenCalledTimes(1);
    const sent = brevo.sendEmail.mock.calls[0][0];
    expect(sent.to).toBe(auth.email);
    expect(sent.subject).toMatch(/reset your password/i);
    expect(sent.html).toContain(emailTemplates.SPAM_FOOTER);

    const token = tokenFromEmail();
    expect(token).toBeTruthy();
    expect(sent.html).toContain(encodeURIComponent(token));

    const confirm = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'FreshPass!2026' });
    expect(confirm.status).toBe(200);

    // old refresh token revoked
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken })).status).toBe(401);
    // old password rejected, new one works
    expect((await request(app).post('/api/v1/auth/login').send({ email: auth.email, password: auth.password })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: auth.email, password: 'FreshPass!2026' })).status).toBe(200);
  });

  it('the reset token is single-use', async () => {
    const auth = await registerAndActivate();
    brevo.sendEmail.mockClear();
    emailSpy.mockClear();
    await request(app).post('/api/v1/auth/password-reset/request').send({ email: auth.email });
    const token = tokenFromEmail();

    await request(app).post('/api/v1/auth/password-reset/confirm').send({ token, newPassword: 'OnceOnly!2026' }).expect(200);
    const second = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'AgainNope!2026' });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('an expired reset token is rejected', async () => {
    const auth = await registerAndActivate();
    brevo.sendEmail.mockClear();
    emailSpy.mockClear();
    await request(app).post('/api/v1/auth/password-reset/request').send({ email: auth.email });
    const token = tokenFromEmail();

    const { hashToken } = require('../../src/core/security/tokens');
    await db.VerificationToken.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { tokenHash: hashToken(token), type: 'password_reset' } }
    );

    const res = await request(app)
      .post('/api/v1/auth/password-reset/confirm')
      .send({ token, newPassword: 'TooLate!2026' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('is enumeration-safe: an unknown email returns 200 and sends nothing', async () => {
    const res = await request(app).post('/api/v1/auth/password-reset/request').send({ email: uniqueEmail('nobody') });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(brevo.sendEmail).not.toHaveBeenCalled();
  });
});
