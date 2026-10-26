'use strict';

// Every SMS the platform pays for goes through notify.sms: the country list
// (SMS_ALLOWED_COUNTRIES), the daily caps for the platform and per store
// (SMS_PLATFORM_DAILY_CAP, SMS_STORE_DAILY_CAP, sms_daily_usage), and the
// merchant phone-verification codes per client a day (VERIFY_PHONE_PER_IP_PER_DAY).

const { QueryTypes } = require('sequelize');
const { app, request, registerAndActivate, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const { utcDay } = require('../../src/modules/notifications/smsBudget');

const saved = { sms: { ...env.sms }, verifyPhone: { ...env.verifyPhone } };
afterEach(() => {
  Object.assign(env.sms, saved.sms);
  Object.assign(env.verifyPhone, saved.verifyPhone);
  jest.restoreAllMocks();
});

const sms = (recipient, workspaceId = null) =>
  notify.sms({ recipient, template: 'otp_checkout', data: { code: '1234', minutes: 5 }, workspaceId });

const usage = () =>
  db.sequelize.query('SELECT scope_key, workspace_id, sent, refused, cap_reached_at FROM sms_daily_usage ORDER BY scope_key', {
    type: QueryTypes.SELECT,
  });
// platform_notifications has no model, so the suite's truncate leaves it: each test reads its own scope.
const capNotices = (scopeKey) =>
  db.sequelize.query("SELECT workspace_id, dedupe_key, data FROM platform_notifications WHERE type = 'sms_cap' AND dedupe_key LIKE :key ORDER BY created_at", {
    replacements: { key: `sms_cap:${scopeKey}:%` },
    type: QueryTypes.SELECT,
  });

describe('SMS_ALLOWED_COUNTRIES', () => {
  it('unset: any number is sent, as before', async () => {
    expect((await sms('966512345678')).status).toBe('sent');
  });

  it('an SMS to another country is not sent and is logged as failed; an allowed one goes', async () => {
    env.sms.allowedCallingCodes = ['20'];
    const refused = await sms('+966512345678');
    expect(refused).toMatchObject({ status: 'failed', attempts: 0 });
    expect(refused.error).toMatch(/SMS_ALLOWED_COUNTRIES/);
    const log = await db.NotificationLog.findOne({ where: { recipient: '+966512345678' } });
    expect(log).toMatchObject({ channel: 'sms', status: 'failed', attempts: 0 });

    expect((await sms('201012345678')).status).toBe('sent');
  });
});

describe('the daily SMS caps', () => {
  it('unset: nothing is counted', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    await sms('201011110000', ctx.workspace.id);
    await sms('201011110001');
    expect(await usage()).toEqual([]);
  });

  it('a store past its cap gets no more SMS that day; the console is told once; other stores go on', async () => {
    const a = await setupWorkspaceWithProduct({ stock: 1 });
    const b = await setupWorkspaceWithProduct({ stock: 1 });
    env.sms.storeDailyCap = 2;

    expect((await sms('201011110010', a.workspace.id)).status).toBe('sent');
    expect((await sms('201011110011', a.workspace.id)).status).toBe('sent');
    const third = await sms('201011110012', a.workspace.id);
    expect(third.status).toBe('failed');
    expect(third.error).toMatch(/SMS_STORE_DAILY_CAP/);
    expect((await sms('201011110013', a.workspace.id)).status).toBe('failed');
    // The platform's own SMS and another store's are not this store's.
    expect((await sms('201011110014')).status).toBe('sent');
    expect((await sms('201011110015', b.workspace.id)).status).toBe('sent');

    const rows = await usage();
    const rowA = rows.find((r) => r.scope_key === `store:${a.workspace.id}`);
    expect(rowA).toMatchObject({ workspace_id: a.workspace.id, sent: 2, refused: 2 });
    expect(rowA.cap_reached_at).not.toBeNull();
    expect(rows.find((r) => r.scope_key === `store:${b.workspace.id}`)).toMatchObject({ sent: 1, refused: 0 });

    const notices = await capNotices(`store:${a.workspace.id}`);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ workspace_id: a.workspace.id, dedupe_key: `sms_cap:store:${a.workspace.id}:${utcDay()}` });
    expect(await capNotices(`store:${b.workspace.id}`)).toHaveLength(0);
    expect(notices[0].data).toMatchObject({ scope: 'store', cap: 2 });

    // Nothing reached the provider for the refused ones: only the sent SMS are logged as sent.
    expect(await db.NotificationLog.count({ where: { workspaceId: a.workspace.id, status: 'sent' } })).toBe(2);
  });

  it('the platform cap counts every SMS; a store slot taken for a refused SMS is given back', async () => {
    const ctx = await setupWorkspaceWithProduct({ stock: 1 });
    env.sms.platformDailyCap = 2;
    env.sms.storeDailyCap = 5;

    expect((await sms('201011110020', ctx.workspace.id)).status).toBe('sent');
    expect((await sms('201011110021')).status).toBe('sent');
    const over = await sms('201011110022', ctx.workspace.id);
    expect(over.status).toBe('failed');
    expect(over.error).toMatch(/SMS_PLATFORM_DAILY_CAP/);
    expect((await sms('201011110023')).status).toBe('failed');

    const rows = await usage();
    expect(rows.find((r) => r.scope_key === 'platform')).toMatchObject({ workspace_id: null, sent: 2, refused: 2 });
    expect(rows.find((r) => r.scope_key === `store:${ctx.workspace.id}`)).toMatchObject({ sent: 1, refused: 0 });
    const notices = await capNotices('platform');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ workspace_id: null, dedupe_key: `sms_cap:platform:${utcDay()}` });
    expect(await capNotices(`store:${ctx.workspace.id}`)).toHaveLength(0);
  });

  it('concurrent sends never pass the cap', async () => {
    env.sms.platformDailyCap = 5;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => sms(`2010111101${String(i).padStart(2, '0')}`)));
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(5);
    const [row] = await usage();
    expect(row).toMatchObject({ sent: 5, refused: 7 });
  });

  it('the SMS goes (logged) when the count cannot be written', async () => {
    env.sms.platformDailyCap = 1;
    const query = db.sequelize.query.bind(db.sequelize);
    jest.spyOn(db.sequelize, 'query').mockImplementation((sql, ...rest) => {
      if (typeof sql === 'string' && sql.includes('sms_daily_usage')) return Promise.reject(new Error('relation "sms_daily_usage" does not exist'));
      return query(sql, ...rest);
    });
    expect((await sms('201011110030')).status).toBe('sent');
    expect((await sms('201011110031')).status).toBe('sent');
  });
});

describe('POST /auth/verify-phone/request', () => {
  const ask = (auth, phone, ip) =>
    request(app)
      .post('/api/v1/auth/verify-phone/request')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .set('X-Forwarded-For', ip)
      .send({ phone });

  it('VERIFY_PHONE_PER_IP_PER_DAY counts every account asking from one client', async () => {
    env.verifyPhone.ipPerDay = 2;
    const accounts = [await registerAndActivate(), await registerAndActivate(), await registerAndActivate()];

    expect((await ask(accounts[0], '01022220001', '198.51.100.90')).status).toBe(200);
    expect((await ask(accounts[1], '01022220002', '198.51.100.90')).status).toBe(200);
    const third = await ask(accounts[2], '01022220003', '198.51.100.90');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('OTP_RATE_LIMITED');
    expect(await db.OtpCode.count({ where: { purpose: 'phone_verification' } })).toBe(2);

    expect((await ask(accounts[2], '01022220003', '198.51.100.91')).status).toBe(200);
  });

  it('unset: no limit per client, as before', async () => {
    const accounts = [await registerAndActivate(), await registerAndActivate(), await registerAndActivate()];
    for (const [i, auth] of accounts.entries()) {
      expect((await ask(auth, `0102222001${i}`, '198.51.100.92')).status).toBe(200);
    }
  });

  it('a number outside SMS_ALLOWED_COUNTRIES is refused before a code is made', async () => {
    env.sms.allowedCallingCodes = ['20'];
    const auth = await registerAndActivate();
    const res = await ask(auth, '+966512345678', '198.51.100.93');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SMS_COUNTRY_NOT_ALLOWED');
    expect(await db.OtpCode.count()).toBe(0);
    expect((await ask(auth, '01022220020', '198.51.100.93')).status).toBe(200);
  });
});
