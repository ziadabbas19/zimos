'use strict';

// The SMS OTP module and the two flows wired onto it (phone verification
// during registration, password reset by SMS). SMS_PROVIDER is `console`
// here; the Twilio adapter is mocked.

jest.mock('../../src/modules/notifications/twilioSmsProvider', () => ({
  sendSms: jest.fn().mockResolvedValue({ sid: 'SM_mock' }),
}));

const twilioSms = require('../../src/modules/notifications/twilioSmsProvider');
const notify = require('../../src/modules/notifications/notify');
const otpService = require('../../src/modules/otp/otpService');
const { app, request, registerAndActivate, uniqueEmail } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const PHONE = '01010101010';

const ORIGINAL_SMS_PROVIDER = env.notifications.smsProvider;

let smsSpy;
beforeEach(() => {
  twilioSms.sendSms.mockClear();
  env.notifications.smsProvider = 'console';
  smsSpy = jest.spyOn(notify, 'sms');
});
afterEach(() => smsSpy.mockRestore());
afterAll(() => {
  env.notifications.smsProvider = ORIGINAL_SMS_PROVIDER;
});

/** Pull the plaintext code out of the (spied) notify.sms call. */
function lastSentCode() {
  const call = smsSpy.mock.calls[smsSpy.mock.calls.length - 1];
  return call[0].data.code;
}

describe('OTP service core behaviour', () => {
  it('a correct code verifies once, then cannot be reused', async () => {
    await otpService.generateAndSendOtp(PHONE, 'phone_verification');
    const code = lastSentCode();

    const first = await otpService.verifyOtp(PHONE, 'phone_verification', code);
    expect(first.verified).toBe(true);

    // consumed — a second verify with the same (now consumed) code fails
    await expect(otpService.verifyOtp(PHONE, 'phone_verification', code)).rejects.toMatchObject({ code: 'INVALID_CODE' });

    const row = await db.OtpCode.findOne({ where: { phone: '201010101010', purpose: 'phone_verification' }, order: [['createdAt', 'DESC']] })
      || await db.OtpCode.findOne({ where: { purpose: 'phone_verification' }, order: [['createdAt', 'DESC']] });
    expect(row.consumedAt).not.toBeNull();
  });

  it('a wrong code is INVALID_CODE', async () => {
    await otpService.generateAndSendOtp(PHONE, 'phone_verification');
    await expect(otpService.verifyOtp(PHONE, 'phone_verification', '000000')).rejects.toMatchObject({
      code: 'INVALID_CODE',
      statusCode: 422,
    });
  });

  it('an expired code is EXPIRED', async () => {
    await otpService.generateAndSendOtp(PHONE, 'phone_verification');
    const code = lastSentCode();
    await db.OtpCode.update(
      { expiresAt: new Date(Date.now() - 1000) },
      { where: { purpose: 'phone_verification' } }
    );
    await expect(otpService.verifyOtp(PHONE, 'phone_verification', code)).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('the 6th wrong attempt in the window is blocked', async () => {
    await otpService.generateAndSendOtp(PHONE, 'phone_verification');
    for (let i = 0; i < 5; i++) {
      await expect(otpService.verifyOtp(PHONE, 'phone_verification', '111111')).rejects.toMatchObject({ code: 'INVALID_CODE' });
    }
    await expect(otpService.verifyOtp(PHONE, 'phone_verification', '111111')).rejects.toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
      statusCode: 429,
    });
  });

  it('caps sends at 3 per phone per 10 minutes', async () => {
    await otpService.generateAndSendOtp(PHONE, 'password_reset');
    await otpService.generateAndSendOtp(PHONE, 'password_reset');
    await otpService.generateAndSendOtp(PHONE, 'password_reset');
    await expect(otpService.generateAndSendOtp(PHONE, 'password_reset')).rejects.toMatchObject({
      code: 'OTP_RATE_LIMITED',
      statusCode: 429,
    });
  });

  it('never stores the raw code', async () => {
    await otpService.generateAndSendOtp(PHONE, 'phone_verification');
    const code = lastSentCode();
    const row = await db.OtpCode.findOne({ where: { purpose: 'phone_verification' }, order: [['createdAt', 'DESC']] });
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).toHaveLength(64); // sha256 hex
  });
});

describe('Twilio adapter wiring', () => {
  it('routes the SMS through the Twilio adapter when SMS_PROVIDER=twilio', async () => {
    env.notifications.smsProvider = 'twilio';
    env.notifications.twilio.accountSid = 'AC_test';
    env.notifications.twilio.authToken = 'tok';
    env.notifications.twilio.fromNumber = '+15550000000';

    await otpService.generateAndSendOtp(PHONE, 'phone_verification');
    const code = lastSentCode();

    expect(twilioSms.sendSms).toHaveBeenCalledTimes(1);
    const arg = twilioSms.sendSms.mock.calls[0][0];
    expect(arg.to).toBe('201010101010');
    expect(arg.body).toContain(code);
  });
});

describe('phone verification during registration', () => {
  it('request + confirm marks the user phone verified', async () => {
    const email = uniqueEmail('otp');
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Passw0rd!123', fullName: 'OTP User' });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken;

    const req1 = await request(app)
      .post('/api/v1/auth/verify-phone/request')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: PHONE });
    expect(req1.status).toBe(200);
    const code = lastSentCode();

    const bad = await request(app)
      .post('/api/v1/auth/verify-phone/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: PHONE, code: '999999' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_CODE');

    const ok = await request(app)
      .post('/api/v1/auth/verify-phone/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: PHONE, code });
    expect(ok.status).toBe(200);

    const user = await db.User.findOne({ where: { email } });
    expect(user.phone).toBe('201010101010');
    expect(user.phoneVerifiedAt).not.toBeNull();
  });
});

describe('password reset by SMS', () => {
  it('request (enumeration-safe) + confirm resets the password', async () => {
    const { email, userId } = await registerAndActivate();
    // give the user a verified phone
    await db.User.update({ phone: '201010101010', phoneVerifiedAt: new Date() }, { where: { id: userId } });

    // unknown phone still returns success
    const unknown = await request(app).post('/api/v1/auth/password-reset/sms/request').send({ phone: '01111111111' });
    expect(unknown.status).toBe(200);
    expect(unknown.body.success).toBe(true);

    const req1 = await request(app).post('/api/v1/auth/password-reset/sms/request').send({ phone: PHONE });
    expect(req1.status).toBe(200);
    const code = lastSentCode();

    const confirm = await request(app)
      .post('/api/v1/auth/password-reset/sms/confirm')
      .send({ phone: PHONE, code, newPassword: 'BrandNewPass!99' });
    expect(confirm.status).toBe(200);

    // old password no longer works, new one does
    const oldLogin = await request(app).post('/api/v1/auth/login').send({ email, password: 'Passw0rd!123' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post('/api/v1/auth/login').send({ email, password: 'BrandNewPass!99' });
    expect(newLogin.status).toBe(200);
  });
});
