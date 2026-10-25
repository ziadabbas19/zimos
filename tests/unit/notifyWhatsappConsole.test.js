'use strict';

// WHATSAPP_PROVIDER=console (notifications/notify.js): outside production the
// message is logged and counted as sent, as before; in production nothing can
// leave, so the send is recorded as failed and the callers fall back to SMS.
// Storage is stubbed out: this file loads no models.
jest.mock('../../src/db/models', () => ({
  NotificationLog: { create: jest.fn() },
}));

const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');

const message = { recipient: '201055551234', template: 'otp_checkout', data: { code: '123456' }, workspaceId: null };

describe('notify.whatsapp with the console provider', () => {
  const saved = {};
  beforeEach(() => {
    saved.whatsapp = env.notifications.whatsappProvider;
    saved.sms = env.notifications.smsProvider;
    saved.isProduction = env.isProduction;
    env.notifications.whatsappProvider = 'console';
    env.notifications.smsProvider = 'console';
    db.NotificationLog.create.mockReset().mockResolvedValue({});
  });
  afterEach(() => {
    env.notifications.whatsappProvider = saved.whatsapp;
    env.notifications.smsProvider = saved.sms;
    env.isProduction = saved.isProduction;
  });

  it('counts the message as sent outside production', async () => {
    env.isProduction = false;
    const result = await notify.whatsapp(message);
    expect(result).toMatchObject({ status: 'sent', error: null });
    expect(db.NotificationLog.create).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp', provider: 'console', status: 'sent' }));
  });

  it('records a failed send in production', async () => {
    env.isProduction = true;
    const result = await notify.whatsapp(message);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/console/);
    expect(db.NotificationLog.create).toHaveBeenCalledWith(expect.objectContaining({ channel: 'whatsapp', provider: 'console', status: 'failed' }));
  });

  it('leaves the SMS console as it was in production', async () => {
    env.isProduction = true;
    const result = await notify.sms(message);
    expect(result.status).toBe('sent');
  });
});

// The callers' fallback, with the real notify: a WhatsApp code sent while
// production runs the console goes out by SMS instead.
describe('the SMS fallback when the WhatsApp console runs in production', () => {
  const saved = {};
  beforeEach(() => {
    saved.whatsapp = env.notifications.whatsappProvider;
    saved.sms = env.notifications.smsProvider;
    saved.isProduction = env.isProduction;
    env.notifications.whatsappProvider = 'console';
    env.notifications.smsProvider = 'console';
    db.NotificationLog.create.mockReset().mockResolvedValue({});
  });
  afterEach(() => {
    env.notifications.whatsappProvider = saved.whatsapp;
    env.notifications.smsProvider = saved.sms;
    env.isProduction = saved.isProduction;
  });

  it('sends a sign-in code by SMS (auth/twoFactorWhatsapp)', async () => {
    env.isProduction = true;
    const { sendCode } = require('../../src/modules/auth/twoFactorWhatsapp');
    const answer = await sendCode({ phone: '+201055551234', phoneVerifiedAt: new Date() }, '123456', { minutes: 5, locale: 'ar' });
    expect(answer).toMatchObject({ channel: 'sms' });
    const channels = db.NotificationLog.create.mock.calls.map(([row]) => [row.channel, row.status]);
    expect(channels).toEqual([
      ['whatsapp', 'failed'],
      ['sms', 'sent'],
    ]);
  });

  it('still answers by WhatsApp outside production', async () => {
    env.isProduction = false;
    const { sendCode } = require('../../src/modules/auth/twoFactorWhatsapp');
    const answer = await sendCode({ phone: '+201055551234', phoneVerifiedAt: new Date() }, '123456', { minutes: 5, locale: 'ar' });
    expect(answer).toMatchObject({ channel: 'whatsapp' });
    expect(db.NotificationLog.create).toHaveBeenCalledTimes(1);
  });
});
