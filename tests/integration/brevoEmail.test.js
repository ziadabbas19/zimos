'use strict';

// Brevo email adapter behind the EMAIL_PROVIDER abstraction. The adapter is
// mocked here; the tests assert the payload the app hands it (subject,
// HTML/text body, and the shared spam-folder footer on every template).

jest.mock('../../src/modules/notifications/brevoEmailProvider', () => ({
  sendEmail: jest.fn().mockResolvedValue({ messageId: 'brevo-mock-1' }),
  buildPayload: jest.requireActual('../../src/modules/notifications/brevoEmailProvider').buildPayload,
  BREVO_ENDPOINT: jest.requireActual('../../src/modules/notifications/brevoEmailProvider').BREVO_ENDPOINT,
}));

const brevo = require('../../src/modules/notifications/brevoEmailProvider');
const { app, request, uniqueEmail, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const emailTemplates = require('../../src/modules/notifications/emailTemplates');

const ORIGINAL_PROVIDER = env.notifications.emailProvider;

beforeEach(() => {
  brevo.sendEmail.mockClear();
  env.notifications.emailProvider = 'brevo';
  env.notifications.brevo.apiKey = 'test-key';
  env.notifications.brevo.fromAddress = 'store@example.com';
  env.notifications.brevo.fromName = 'Store Builder';
});

afterAll(() => {
  env.notifications.emailProvider = ORIGINAL_PROVIDER;
});

describe('Brevo email adapter', () => {
  it('registration sends the verification email through Brevo with the right payload', async () => {
    const email = uniqueEmail('brevo');
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Passw0rd!123', fullName: 'Brevo Tester' });
    expect(res.status).toBe(201);

    expect(brevo.sendEmail).toHaveBeenCalledTimes(1);
    const arg = brevo.sendEmail.mock.calls[0][0];
    expect(arg.to).toBe(email);
    expect(arg.subject).toMatch(/confirm your email/i);
    expect(arg.html).toMatch(/\/verify-email\?token=[^"'\s]+/);
    expect(arg.html).toContain(emailTemplates.SPAM_FOOTER);
    expect(arg.text).toContain(emailTemplates.SPAM_FOOTER);

    // and it was logged against the brevo provider
    const log = await db.NotificationLog.findOne({ where: { recipient: email, channel: 'email' } });
    expect(log.provider).toBe('brevo');
    expect(log.status).toBe('sent');
  });

  it('password-reset request sends a reset email through Brevo', async () => {
    const { email } = await registerAndActivate();
    brevo.sendEmail.mockClear();

    const res = await request(app).post('/api/v1/auth/password-reset/request').send({ email });
    expect(res.status).toBe(200);

    expect(brevo.sendEmail).toHaveBeenCalledTimes(1);
    const arg = brevo.sendEmail.mock.calls[0][0];
    expect(arg.subject).toMatch(/reset your password/i);
    expect(arg.html).toMatch(/\/reset-password\?token=/);
    expect(arg.html).toContain(emailTemplates.SPAM_FOOTER);
  });

  it('every registered template carries the shared spam-folder footer in html and text', () => {
    for (const name of emailTemplates.TEMPLATE_NAMES) {
      const out = emailTemplates.render(name, { token: 'tok', fullName: 'X', workspaceName: 'WS', roleName: 'Owner' });
      expect(out.subject).toBeTruthy();
      expect(out.html).toContain(emailTemplates.SPAM_FOOTER);
      expect(out.text).toContain(emailTemplates.SPAM_FOOTER);
    }
  });

  it('buildPayload matches the Brevo transactional shape', () => {
    const p = brevo.buildPayload({
      to: 'a@b.com',
      subject: 'Hi',
      html: '<p>x</p>',
      text: 'x',
      fromAddress: 'store@example.com',
      fromName: 'Store Builder',
    });
    expect(p).toEqual({
      sender: { email: 'store@example.com', name: 'Store Builder' },
      to: [{ email: 'a@b.com' }],
      subject: 'Hi',
      htmlContent: '<p>x</p>',
      textContent: 'x',
    });
  });

  it('with EMAIL_PROVIDER=console the real adapter is never called', async () => {
    env.notifications.emailProvider = 'console';
    const email = uniqueEmail('console');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Passw0rd!123', fullName: 'Console Tester' })
      .expect(201);

    expect(brevo.sendEmail).not.toHaveBeenCalled();
    const log = await db.NotificationLog.findOne({ where: { recipient: email, channel: 'email' } });
    expect(log.provider).toBe('console');
    expect(log.status).toBe('sent');
  });
});
