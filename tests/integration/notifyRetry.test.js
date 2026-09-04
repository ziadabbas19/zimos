'use strict';

// Retry-with-backoff around the real provider calls. The Brevo fetch and the
// Twilio client are mocked; retry delays are zero under NODE_ENV=test.
//   - a transient failure (network / 429 / 5xx) is retried and can recover
//   - a permanent failure (4xx) is NOT retried
//   - if every attempt fails, the send is logged as failed and nothing throws

jest.mock('twilio', () => jest.fn());

const twilioFactory = require('twilio');
const notify = require('../../src/modules/notifications/notify');
const twilioSmsProvider = require('../../src/modules/notifications/twilioSmsProvider');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const ORIGINAL = {
  email: env.notifications.emailProvider,
  sms: env.notifications.smsProvider,
};

const okResponse = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
const errResponse = (status, body = 'error body') => ({ ok: false, status, json: async () => ({}), text: async () => body });
const httpErr = (status, extra = {}) => Object.assign(new Error(`status ${status}`), { status, ...extra });

let fetchSpy;
const smsCreate = jest.fn();

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse({ messageId: 'default' }));
  smsCreate.mockReset().mockResolvedValue({ sid: 'SM_default' });
  twilioFactory.mockReset().mockReturnValue({ messages: { create: smsCreate } });
  twilioSmsProvider._resetClient();

  env.notifications.emailProvider = 'brevo';
  Object.assign(env.notifications.brevo, { apiKey: 'k', fromAddress: 'from@zimos.test', fromName: 'Zimos' });
  env.notifications.smsProvider = 'twilio';
  Object.assign(env.notifications.twilio, { accountSid: 'AC', authToken: 't', fromNumber: '+15550000000' });
});

afterEach(() => fetchSpy.mockRestore());
afterAll(() => {
  env.notifications.emailProvider = ORIGINAL.email;
  env.notifications.smsProvider = ORIGINAL.sms;
});

const lastLog = (recipient, channel) =>
  db.NotificationLog.findOne({ where: { recipient, channel }, order: [['createdAt', 'DESC']] });

describe('email (Brevo) retry', () => {
  it('retries a transient failure and recovers — log shows 2 attempts', async () => {
    fetchSpy
      .mockReset()
      .mockRejectedValueOnce(new TypeError('fetch failed')) // network blip, no HTTP status
      .mockResolvedValueOnce(okResponse({ messageId: 'm-recovered' }));

    const r = await notify.email({ recipient: 'recover@zimos.test', template: 'password_reset', data: { token: 'tok' } });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: 'sent', attempts: 2 });
    const log = await lastLog('recover@zimos.test', 'email');
    expect(log).toMatchObject({ status: 'sent', attempts: 2, provider: 'brevo' });
  });

  it('does NOT retry a permanent 4xx — fails fast on the first attempt', async () => {
    fetchSpy.mockReset().mockResolvedValue(errResponse(422, 'invalid recipient'));

    const r = await notify.email({ recipient: 'perm@zimos.test', template: 'password_reset', data: { token: 'tok' } });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: 'failed', attempts: 1 });
    const log = await lastLog('perm@zimos.test', 'email');
    expect(log).toMatchObject({ status: 'failed', attempts: 1 });
    expect(log.error).toContain('422');
  });

  it('when all 3 attempts fail: logs the failure, records attempts, does not throw', async () => {
    fetchSpy.mockReset().mockRejectedValue(new TypeError('network down'));

    const r = await notify.email({ recipient: 'exhaust@zimos.test', template: 'password_reset', data: { token: 'tok' } });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ status: 'failed', attempts: 3 });
    const log = await lastLog('exhaust@zimos.test', 'email');
    expect(log).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('the console provider path is unaffected (1 attempt, no fetch)', async () => {
    env.notifications.emailProvider = 'console';
    fetchSpy.mockReset();

    const r = await notify.email({ recipient: 'console@zimos.test', template: 'password_reset', data: { token: 'tok' } });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await lastLog('console@zimos.test', 'email')).toMatchObject({ status: 'sent', attempts: 1, provider: 'console' });
  });
});

describe('SMS (Twilio) retry', () => {
  it('retries a 5xx and recovers — log shows 2 attempts', async () => {
    smsCreate.mockReset().mockRejectedValueOnce(httpErr(500)).mockResolvedValueOnce({ sid: 'SM-recovered' });

    const r = await notify.sms({ recipient: '01000001111', template: 'otp_verify', data: { code: '123456' } });

    expect(smsCreate).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: 'sent', attempts: 2 });
    const log = await lastLog('01000001111', 'sms');
    expect(log).toMatchObject({ status: 'sent', attempts: 2, provider: 'twilio' });
  });

  it('does NOT retry an invalid-phone 4xx — fails fast', async () => {
    smsCreate.mockReset().mockRejectedValue(httpErr(400, { code: 21211, message: "invalid 'To' number" }));

    const r = await notify.sms({ recipient: '01000002222', template: 'otp_verify', data: { code: '123456' } });

    expect(smsCreate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await lastLog('01000002222', 'sms')).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('when all 3 attempts fail: logs the failure, records attempts, does not throw', async () => {
    smsCreate.mockReset().mockRejectedValue(httpErr(503));

    const r = await notify.sms({ recipient: '01000003333', template: 'otp_verify', data: { code: '123456' } });

    expect(smsCreate).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await lastLog('01000003333', 'sms')).toMatchObject({ status: 'failed', attempts: 3 });
  });
});
