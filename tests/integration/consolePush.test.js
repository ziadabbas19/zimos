'use strict';

// Device notifications for the console (platformAdmin/consolePush.js, migration 745):
// a bell row reaches the devices of the accounts the bell shows it to and nobody else,
// once per event, in each device's language; a device the push service dropped is
// deleted; the "on my devices" choice per type; and off = nothing. No real push is
// sent: web-push's sendNotification is replaced in every test.

const crypto = require('crypto');
const webpush = require('web-push');
const { app, request, makePlatformUser, addPlatformKeys } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notifications = require('../../src/modules/platformAdmin/platformNotificationService');
const consolePush = require('../../src/modules/platformAdmin/consolePush');
const { PLATFORM_PERMISSIONS: P } = require('../../src/core/security/platformPermissions');

const loaded = { ...env.push };

let sendSpy;
beforeEach(async () => {
  // platform_notifications has no model, so the truncation between tests leaves it.
  await db.sequelize.query('DELETE FROM platform_notifications');
  sendSpy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
  const keys = webpush.generateVAPIDKeys();
  Object.assign(env.push, { enabled: true, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:ops@zimos.test' });
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.assign(env.push, loaded);
});

function browser() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

/** A console account holding exactly `keys` (or a role's own set), with a console device in `locale`. */
async function admin({ role = 'admin', keys = null, locale = 'en' } = {}) {
  const account = await makePlatformUser(role);
  if (keys) await db.User.update({ platformPermissions: keys }, { where: { id: account.userId } });
  const sub = browser();
  const res = await request(app).put('/api/v1/me/push/subscriptions').set(account.H).send({ app: 'console', subscription: sub, locale });
  expect(res.status).toBe(200);
  // Signing an account up is a "new sign-up" for the accounts made before it: not what a test is about.
  sendSpy.mockClear();
  return { ...account, endpoint: sub.endpoint, deviceId: res.body.subscription.id };
}

const sentTo = () => sendSpy.mock.calls.map(([target, payload]) => ({ endpoint: target.endpoint, ...JSON.parse(payload) }));

describe('who a console notification reaches', () => {
  it("the accounts whose bell shows it, in each device's language; not the one who did it, nor a type turned off", async () => {
    const support = await admin({ keys: [P.SUPPORT_VIEW], locale: 'ar' });
    const other = await admin({ keys: [P.WORKSPACES_VIEW] });
    const actor = await admin({ keys: [P.SUPPORT_VIEW] });
    const quiet = await admin({ keys: [P.SUPPORT_VIEW] });
    const prefs = await request(app)
      .put('/api/v1/admin/notification-prefs')
      .set(quiet.H)
      .send({ prefs: [{ type: 'support_ticket', enabled: true, email: false, push: false }] });
    expect(prefs.status).toBe(200);

    await notifications.notify({ type: 'support_ticket', title: 'New support ticket', link: '/tickets/t1', actorUserId: actor.userId });

    const sent = sentTo();
    expect(sent.map((p) => p.endpoint)).toEqual([support.endpoint]);
    expect(sent[0]).toMatchObject({ type: 'console.support_ticket', title: 'Zimos', body: 'تذكرة دعم جديدة', url: '/tickets/t1', count: 1 });
    expect([other, actor, quiet].some((a) => sent.some((p) => p.endpoint === a.endpoint))).toBe(false);
  });

  it("a row's own recipients and hidden accounts, a creator aside; the review's code in the text", async () => {
    const author = await admin({ keys: [P.REFERRAL_CODES_APPROVE] });
    const reviewer = await admin({ keys: [P.REFERRAL_CODES_APPROVE] });
    const creator = await admin({ role: 'creator' });

    await notifications.notify({
      type: 'referral_code_review',
      title: 'waiting',
      link: '/referral-codes/c1',
      data: { codeId: 'c1', code: 'NILE10', change: 'new', actorName: 'Someone Private' },
      hiddenFrom: [author.userId, creator.userId],
      dedupeKey: 'referral_code_review:c1',
      refresh: true,
    });

    const sent = sentTo();
    expect(sent.map((p) => p.endpoint).sort()).toEqual([reviewer.endpoint, creator.endpoint].sort());
    expect(sent[0].body).toBe('Code NILE10 is waiting for review');
    expect(JSON.stringify(sent)).not.toContain('Someone Private');
  });

  it('a decision only to the accounts it names, opened on My referrals without agents.view', async () => {
    const owner = await admin({ keys: [P.REFERRALS_VIEW_OWN] });
    const bystander = await admin({ keys: [P.REFERRALS_VIEW_OWN] });
    await notifications.notify({
      type: 'referral_code_decided',
      title: 'decided',
      link: '/referral-codes/c2',
      data: { codeId: 'c2', code: 'NILE20', decision: 'rejected', change: 'new' },
      recipients: [owner.userId],
    });
    const sent = sentTo();
    expect(sent.map((p) => p.endpoint)).toEqual([owner.endpoint]);
    expect(sent[0]).toMatchObject({ type: 'console.referral_code_rejected', body: 'Code NILE20 was rejected', url: '/my-referrals' });
    expect(sent.some((p) => p.endpoint === bystander.endpoint)).toBe(false);
  });
});

describe('once per event', () => {
  it('the same row sent again reaches nobody twice; a review changed again (a refresh) is a new event', async () => {
    const reviewer = await admin({ keys: [P.REFERRAL_CODES_APPROVE] });
    const fields = { type: 'referral_code_review', title: 'waiting', link: '/referral-codes/c3', data: { code: 'NILE30' }, dedupeKey: 'referral_code_review:c3', refresh: true };
    await notifications.notify(fields);
    const [{ id }] = await db.sequelize.query("SELECT id FROM platform_notifications WHERE dedupe_key = 'referral_code_review:c3'", { type: db.Sequelize.QueryTypes.SELECT });
    await consolePush.send(id);
    await consolePush.send(id);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    await notifications.notify(fields);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sentTo().every((p) => p.endpoint === reviewer.endpoint)).toBe(true);
  });

  it('a duplicate key the bell skips sends nothing', async () => {
    await admin({ keys: [P.SUBSCRIPTIONS_VIEW] });
    const fields = { type: 'subscription_expired', title: 'Subscription ended', link: '/workspaces/w1', dedupeKey: 'expired:s1:2026-11-01' };
    await notifications.notify(fields);
    await notifications.notify(fields);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('a device the push service dropped', () => {
  it.each([404, 410])('%s: the device is deleted', async (statusCode) => {
    const account = await admin({ keys: [P.SUPPORT_VIEW] });
    sendSpy.mockRejectedValue(Object.assign(new Error('gone'), { statusCode, headers: {} }));
    await notifications.notify({ type: 'support_ticket', title: 'New support ticket', link: '/tickets/t2' });
    expect(await db.PushSubscription.findByPk(account.deviceId)).toBeNull();
  });
});

describe('push off', () => {
  it('nothing is sent and nothing is marked', async () => {
    await admin({ keys: [P.SUPPORT_VIEW] });
    env.push.enabled = false;
    await notifications.notify({ type: 'support_ticket', title: 'New support ticket', link: '/tickets/t3' });
    expect(sendSpy).not.toHaveBeenCalled();
    const [{ count }] = await db.sequelize.query('SELECT COUNT(*)::int AS count FROM platform_notification_pushes', { type: db.Sequelize.QueryTypes.SELECT });
    expect(count).toBe(0);
  });
});

describe('the "on my devices" choice', () => {
  it('defaults to on, is saved per type, and a save without it keeps it', async () => {
    const account = await makePlatformUser('admin');
    await addPlatformKeys(account.userId, [P.SUPPORT_VIEW]);
    const first = await request(app).get('/api/v1/admin/notification-prefs').set(account.H);
    expect(first.body.pushDelivery).toBe(true);
    expect(first.body.prefs.find((p) => p.type === 'support_ticket')).toMatchObject({ enabled: true, push: true });

    await request(app).put('/api/v1/admin/notification-prefs').set(account.H).send({ prefs: [{ type: 'support_ticket', enabled: true, push: false }] });
    await request(app).put('/api/v1/admin/notification-prefs').set(account.H).send({ prefs: [{ type: 'support_ticket', enabled: true }] });
    const after = await request(app).get('/api/v1/admin/notification-prefs').set(account.H);
    expect(after.body.prefs.find((p) => p.type === 'support_ticket')).toMatchObject({ enabled: true, push: false });
  });
});
