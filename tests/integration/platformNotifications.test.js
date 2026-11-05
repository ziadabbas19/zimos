'use strict';

// The console's notifications (platformAdmin/platformNotificationService):
// rows from the events, read state per admin, preferences, the permission
// gate and pagination.

const { QueryTypes } = require('sequelize');
const { app, request, registerAndActivate, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const billingService = require('../../src/modules/billing/billingService');
const charges = require('../../src/modules/billing/subscriptionChargeService');
const { recordAudit } = require('../../src/modules/audit/auditService');
const notifications = require('../../src/modules/platformAdmin/platformNotificationService');

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await billingService.seedDefaultPlans();
});

const rows = (type) =>
  db.sequelize.query('SELECT * FROM platform_notifications WHERE type = :type ORDER BY created_at', { replacements: { type }, type: QueryTypes.SELECT });

async function store(name = 'Notified Store') {
  const owner = await registerAndActivate();
  const res = await request(app).post('/api/v1/workspaces').set('Authorization', `Bearer ${owner.accessToken}`).send({ name });
  return { wid: res.body.workspace.id, owner };
}

describe('console notifications', () => {
  it('sign-up, new store, manual activation and suspension each write a row', async () => {
    const { wid, owner } = await store();
    expect((await rows('user_signup')).some((r) => r.subject_user_id === owner.userId)).toBe(true);
    expect((await rows('workspace_created')).some((r) => r.workspace_id === wid)).toBe(true);

    const admin = await makePlatformUser('admin');
    const growth = await db.Plan.findOne({ where: { key: 'growth' } });
    const act = await request(app)
      .post(`/api/v1/admin/workspaces/${wid}/subscription/activate`)
      .set(admin.H)
      .send({ planId: growth.id, duration: { months: 1 }, pricingKind: 'free', note: 'Launch partner' });
    expect(act.status).toBe(201);
    const activated = (await rows('subscription_activated')).find((r) => r.workspace_id === wid);
    expect(activated).toMatchObject({ workspace_id: wid, actor_user_id: admin.userId, body: 'Launch partner' });
    expect(activated.data.pricing).toMatchObject({ kind: 'free' });

    const victim = await registerAndActivate();
    const creator = await makePlatformUser('creator');
    const sus = await request(app).post(`/api/v1/admin/users/${victim.userId}/suspend`).set(creator.H).send({ reason: 'Spam', confirm: true });
    expect(sus.status).toBe(200);
    expect((await rows('user_suspended')).some((r) => r.subject_user_id === victim.userId)).toBe(true);
  });

  it('proof, ticket and referral audits, a failed charge and the sweep each write a row', async () => {
    const { wid } = await store();
    for (const action of ['payment_proof.submit', 'support_ticket.create', 'subscription.referral_code_attach']) {
      await recordAudit({ workspaceId: wid, action, entityType: 'X', entityId: wid });
    }
    const mine = async (type) => (await rows(type)).filter((r) => r.workspace_id === wid);
    expect(await mine('payment_proof_submitted')).toHaveLength(1);
    expect(await mine('support_ticket')).toHaveLength(1);
    expect(await mine('referral_signup')).toHaveLength(1);

    const growth = await db.Plan.findOne({ where: { key: 'growth' } });
    await db.Subscription.update({ planId: growth.id }, { where: { workspaceId: wid } });
    const { invoice } = await charges.createCharge(wid);
    await charges.markChargeFailed(invoice.id, { reason: 'Card declined' });
    expect(await mine('payment_failed')).toEqual([expect.objectContaining({ workspace_id: wid, body: 'Card declined' })]);

    const ending = await store('Ending');
    const ended = await store('Ended');
    await db.Subscription.update({ status: 'active', currentPeriodEnd: new Date(Date.now() + 3 * DAY_MS) }, { where: { workspaceId: ending.wid } });
    await db.Subscription.update({ status: 'active', currentPeriodEnd: new Date(Date.now() - DAY_MS) }, { where: { workspaceId: ended.wid } });
    await notifications.sweepSubscriptions();
    await notifications.sweepSubscriptions();
    expect((await rows('subscription_expiring')).filter((r) => r.workspace_id === ending.wid)).toHaveLength(1);
    expect((await rows('subscription_expired')).filter((r) => r.workspace_id === ended.wid)).toHaveLength(1);
  });

  it('a failed notification never fails the change', async () => {
    await db.sequelize.transaction(async (transaction) => {
      await notifications.notify({ type: 'not_a_type', title: 'x' }, transaction);
      // The transaction still works after the refused insert (savepoint).
      await db.sequelize.query('SELECT 1', { transaction });
    });
  });

  it('read state is per admin; mark all read; unread count', async () => {
    const a = await makePlatformUser('admin');
    const b = await makePlatformUser('admin');
    const list = await request(app).get('/api/v1/admin/notifications').set(a.H);
    expect(list.status).toBe(200);
    const first = list.body.notifications[0];
    expect(first.readAt).toBeNull();

    const before = (await request(app).get('/api/v1/admin/notifications/unread-count').set(b.H)).body.unread;
    const read = await request(app).post('/api/v1/admin/notifications/read').set(a.H).send({ ids: [first.id] });
    expect(read.status).toBe(200);
    expect((await request(app).get('/api/v1/admin/notifications/unread-count').set(b.H)).body.unread).toBe(before);
    const again = await request(app).get('/api/v1/admin/notifications').set(a.H);
    expect(again.body.notifications.find((n) => n.id === first.id).readAt).not.toBeNull();

    await request(app).post('/api/v1/admin/notifications/read').set(a.H).send({ all: true });
    expect((await request(app).get('/api/v1/admin/notifications/unread-count').set(a.H)).body.unread).toBe(0);
    const unreadOnly = await request(app).get('/api/v1/admin/notifications?unread=true').set(a.H);
    expect(unreadOnly.body.notifications).toHaveLength(0);
  });

  it('a type turned off is hidden for that admin only; email stays off by default', async () => {
    const a = await makePlatformUser('admin');
    const b = await makePlatformUser('admin');
    const prefs = await request(app).get('/api/v1/admin/notification-prefs').set(a.H);
    // Everything but what waits for review, which takes referral_codes.approve.
    expect(prefs.body.prefs.map((p) => p.type).sort()).toEqual(notifications.TYPES.filter((t) => !['referral_code_review', 'agent_link_review'].includes(t)).sort());
    expect(prefs.body.prefs.every((p) => p.enabled && !p.email)).toBe(true);

    const put = await request(app).put('/api/v1/admin/notification-prefs').set(a.H).send({ prefs: [{ type: 'user_signup', enabled: false, email: true }] });
    expect(put.status).toBe(200);
    expect(put.body.prefs.find((p) => p.type === 'user_signup')).toEqual({ type: 'user_signup', enabled: false, email: true });

    const forA = await request(app).get('/api/v1/admin/notifications?limit=50').set(a.H);
    const forB = await request(app).get('/api/v1/admin/notifications?limit=50').set(b.H);
    expect(forA.body.notifications.some((n) => n.type === 'user_signup')).toBe(false);
    expect(forB.body.notifications.some((n) => n.type === 'user_signup')).toBe(true);

    expect((await request(app).put('/api/v1/admin/notification-prefs').set(a.H).send({ prefs: [{ type: 'nope', enabled: true }] })).status).toBe(422);
  });

  it('needs a console account', async () => {
    const merchant = await registerAndActivate();
    const H = { Authorization: `Bearer ${merchant.accessToken}` };
    expect((await request(app).get('/api/v1/admin/notifications').set(H)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/notifications/unread-count').set(H)).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/notifications/read').set(H).send({ all: true })).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/notification-prefs').set(H)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/notifications')).status).toBe(401);
  });

  it('pages newest first with a cursor', async () => {
    const admin = await makePlatformUser('admin');
    await db.sequelize.query('DELETE FROM platform_notifications');
    for (let i = 0; i < 5; i += 1) {
      await notifications.notify({ type: 'support_ticket', title: `Ticket ${i}` });
    }
    const seen = [];
    let cursor = null;
    do {
      const res = await request(app)
        .get(`/api/v1/admin/notifications?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(admin.H);
      expect(res.status).toBe(200);
      seen.push(...res.body.notifications.map((n) => n.title));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['Ticket 4', 'Ticket 3', 'Ticket 2', 'Ticket 1', 'Ticket 0']);
    expect((await request(app).get('/api/v1/admin/notifications?type=support_ticket&cursor=bad').set(admin.H)).status).toBe(422);
  });
});

describe('console notifications by permission', () => {
  async function consoleUser(permissions) {
    const u = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: permissions }, { where: { id: u.userId } });
    return u;
  }

  it('an admin is told only about the types their console permissions open', async () => {
    await db.sequelize.query('DELETE FROM platform_notifications');
    await notifications.notify({ type: 'payment_proof_submitted', title: 'Proof' });
    await notifications.notify({ type: 'support_ticket', title: 'Ticket' });
    await notifications.notify({ type: 'suggestion', title: 'Idea' });
    await notifications.notify({ type: 'wallet_fallback', title: 'Fallback' });

    const overviewOnly = await consoleUser(['overview.view']);
    const list = await request(app).get('/api/v1/admin/notifications').set(overviewOnly.H);
    expect(list.status).toBe(200);
    expect(list.body.notifications).toHaveLength(0);
    expect(list.body.unread).toBe(0);
    expect((await request(app).get('/api/v1/admin/notifications/unread-count').set(overviewOnly.H)).body.unread).toBe(0);
    expect((await request(app).get('/api/v1/admin/notification-prefs').set(overviewOnly.H)).body.prefs).toEqual([]);

    const support = await consoleUser(['overview.view', 'support.view']);
    const seen = (await request(app).get('/api/v1/admin/notifications').set(support.H)).body.notifications.map((n) => n.type).sort();
    expect(seen).toEqual(['suggestion', 'support_ticket']);
    expect((await request(app).get('/api/v1/admin/notifications?type=payment_proof_submitted').set(support.H)).body.notifications).toHaveLength(0);
    const prefTypes = (await request(app).get('/api/v1/admin/notification-prefs').set(support.H)).body.prefs.map((p) => p.type).sort();
    expect(prefTypes).toEqual(['suggestion', 'support_ticket']);

    // "Mark all read" marks only what this admin can see.
    await request(app).post('/api/v1/admin/notifications/read').set(support.H).send({ all: true });
    const [{ count }] = await db.sequelize.query('SELECT COUNT(*)::int AS count FROM platform_notification_reads WHERE user_id = :u', {
      replacements: { u: support.userId },
      type: QueryTypes.SELECT,
    });
    expect(count).toBe(2);

    const payments = await consoleUser(['overview.view', 'payments.record', 'subscriptions.view']);
    const forPayments = (await request(app).get('/api/v1/admin/notifications').set(payments.H)).body.notifications.map((n) => n.type).sort();
    expect(forPayments).toEqual(['payment_proof_submitted', 'wallet_fallback']);
  });

  it('opens for any console account, overview.view or not, and tells each only what its permissions open', async () => {
    await db.sequelize.query('DELETE FROM platform_notifications');
    await notifications.notify({ type: 'payment_proof_submitted', title: 'Proof' });
    await notifications.notify({ type: 'support_ticket', title: 'Ticket' });

    const support = await consoleUser(['support.view']);
    const list = await request(app).get('/api/v1/admin/notifications').set(support.H);
    expect(list.status).toBe(200);
    expect(list.body.notifications.map((n) => n.title)).toEqual(['Ticket']);
    expect(list.body.unread).toBe(1);
    expect((await request(app).get('/api/v1/admin/notifications/unread-count').set(support.H)).body.unread).toBe(1);
    expect((await request(app).get('/api/v1/admin/notifications?type=payment_proof_submitted').set(support.H)).body.notifications).toEqual([]);
    expect((await request(app).get('/api/v1/admin/notification-prefs').set(support.H)).body.prefs.map((p) => p.type).sort()).toEqual(['suggestion', 'support_ticket']);

    // No keys, and an agent: the bell works and is empty. An agent can only be told how their own codes' reviews went.
    for (const [who, types] of [
      [await consoleUser([]), []],
      [await makePlatformUser('agent'), ['referral_code_decided']],
    ]) {
      const empty = await request(app).get('/api/v1/admin/notifications').set(who.H);
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ notifications: [], unread: 0 });
      expect((await request(app).get('/api/v1/admin/notifications/unread-count').set(who.H)).body.unread).toBe(0);
      expect((await request(app).get('/api/v1/admin/notification-prefs').set(who.H)).body.prefs.map((p) => p.type)).toEqual(types);
      expect((await request(app).post('/api/v1/admin/notifications/read').set(who.H).send({ all: true })).status).toBe(200);
    }
  });

  it('marks read only what the account can see, by id as well as all', async () => {
    await db.sequelize.query('DELETE FROM platform_notifications');
    await notifications.notify({ type: 'payment_proof_submitted', title: 'Proof' });
    await notifications.notify({ type: 'support_ticket', title: 'Ticket' });
    const [proof] = await rows('payment_proof_submitted');
    const [ticket] = await rows('support_ticket');
    const reads = async (userId) => {
      const found = await db.sequelize.query('SELECT notification_id FROM platform_notification_reads WHERE user_id = :userId', {
        replacements: { userId },
        type: QueryTypes.SELECT,
      });
      return found.map((r) => r.notification_id);
    };

    const support = await consoleUser(['support.view']);
    const res = await request(app).post('/api/v1/admin/notifications/read').set(support.H).send({ ids: [proof.id, ticket.id] });
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(0);
    expect(await reads(support.userId)).toEqual([ticket.id]);

    const nobody = await consoleUser([]);
    expect((await request(app).post('/api/v1/admin/notifications/read').set(nobody.H).send({ ids: [proof.id] })).status).toBe(200);
    expect(await reads(nobody.userId)).toEqual([]);
  });
});
