'use strict';

// The send path with its storage and its provider stubbed out: this file
// loads no models.
jest.mock('../../src/db/models', () => ({
  OtpCode: { count: jest.fn(), create: jest.fn() },
}));
jest.mock('../../src/modules/notifications/notify', () => ({
  sms: jest.fn().mockResolvedValue({ status: 'sent' }),
  whatsapp: jest.fn().mockResolvedValue({ status: 'sent' }),
}));

const db = require('../../src/db/models');
const notify = require('../../src/modules/notifications/notify');
const env = require('../../src/config/env');
const otpService = require('../../src/modules/otp/otpService');

// One-time codes over SMS (otp/otpService): the row keeps who asked, and a
// code that cannot leave is refused instead of being reported as sent.
describe('generateAndSendOtp', () => {
  const saved = {};
  beforeEach(() => {
    saved.provider = env.notifications.smsProvider;
    saved.isProduction = env.isProduction;
    env.notifications.smsProvider = 'console';
    env.isProduction = false;
    db.OtpCode.count.mockReset().mockResolvedValue(0);
    db.OtpCode.create.mockReset().mockResolvedValue({});
    notify.sms.mockClear();
    notify.whatsapp.mockClear();
  });
  afterEach(() => {
    env.notifications.smsProvider = saved.provider;
    env.isProduction = saved.isProduction;
  });

  it('keeps the asking client on the row', async () => {
    await otpService.generateAndSendOtp('01010101010', 'phone_verification', { requestIp: '198.51.100.7' });
    expect(db.OtpCode.create).toHaveBeenCalledTimes(1);
    expect(db.OtpCode.create.mock.calls[0][0]).toMatchObject({ purpose: 'phone_verification', requestIp: '198.51.100.7' });
    expect(notify.sms).toHaveBeenCalledTimes(1);
  });

  it('leaves the client empty when the caller names none, as before', async () => {
    await otpService.generateAndSendOtp('01010101010', 'password_reset');
    expect(db.OtpCode.create.mock.calls[0][0].requestIp).toBeNull();
  });

  it('answers 503 and stores nothing when SMS cannot leave', async () => {
    // The console provider in production writes a log line and sends nothing.
    env.isProduction = true;
    await expect(otpService.generateAndSendOtp('01010101010', 'phone_verification')).rejects.toMatchObject({
      code: 'SMS_UNAVAILABLE',
      statusCode: 503,
    });
    expect(db.OtpCode.create).not.toHaveBeenCalled();
    expect(notify.sms).not.toHaveBeenCalled();
  });

  it('answers 503 for a provider with no credentials', async () => {
    const twilio = { ...env.notifications.twilio };
    env.notifications.smsProvider = 'twilio';
    env.notifications.twilio.accountSid = '';
    try {
      await expect(otpService.generateAndSendOtp('01010101010', 'phone_verification')).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      Object.assign(env.notifications.twilio, twilio);
    }
  });

  it('still refuses a fourth code to one phone in ten minutes', async () => {
    db.OtpCode.count.mockResolvedValue(otpService.MAX_SENDS_PER_WINDOW);
    await expect(otpService.generateAndSendOtp('01010101010', 'phone_verification')).rejects.toMatchObject({
      code: 'OTP_RATE_LIMITED',
      statusCode: 429,
    });
  });
});
