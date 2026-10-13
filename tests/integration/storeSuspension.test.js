'use strict';

// Manual store suspension (workspaces.manage), independent of billing:
//
//   GET  /admin/workspaces/:workspaceId/access       workspaces.view
//   POST /admin/workspaces/:workspaceId/suspend      workspaces.manage
//   POST /admin/workspaces/:workspaceId/reactivate   workspaces.manage
//
// A suspended store is restricted exactly like an unpaid one past its grace
// day. Either reason on its own keeps it restricted.

const { app, request, registerAndActivate, createWorkspace, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGINAL_MODE = env.billing.restrictions;

beforeEach(async () => {
  env.billing.restrictions = 'enforce';
  await billingService.seedDefaultPlans();
});

afterAll(() => {
  env.billing.restrictions = ORIGINAL_MODE;
});

async function setup() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Suspendable Store');
  const starter = await db.Plan.findOne({ where: { key: 'starter' } });
  await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: workspace.id } });
  return { wid: workspace.id, H: { Authorization: `Bearer ${owner.accessToken}` } };
}

const suspend = (actor, wid, body = { reason: 'Chargeback investigation' }) =>
  request(app).post(`/api/v1/admin/workspaces/${wid}/suspend`).set(actor.H).send(body);
const reactivate = (actor, wid, body = { reason: 'Cleared' }) =>
  request(app).post(`/api/v1/admin/workspaces/${wid}/reactivate`).set(actor.H).send(body);
const merchantAccess = async (wid, H) => (await request(app).get(`/api/v1/workspaces/${wid}/access`).set(H)).body.access;
const createProduct = (wid, H) =>
  request(app).post(`/api/v1/workspaces/${wid}/catalog/products`).set(H).send({ name: 'New', status: 'active' });

describe('the ad product feed of a suspended store', () => {
  it('stops with the storefront, the copy kept from before included, and comes back with it', async () => {
    const { wid, H } = await setup();
    const admin = await makePlatformUser('admin');
    const slug = (await db.Workspace.findByPk(wid)).slug;
    const product = await request(app)
      .post(`/api/v1/workspaces/${wid}/catalog/products`)
      .set(H)
      .send({ name: 'Feed Lamp', status: 'active' });
    expect(product.status).toBe(201);
    const saved = await request(app).put(`/api/v1/workspaces/${wid}/offers/feed`).set(H).send({ enabled: true, excludeOutOfStock: false });
    expect(saved.status).toBe(200);

    const feed = () => request(app).get(`/api/v1/feeds/${slug}/meta.xml`);
    // Open: served, and kept for the feed's ten minutes.
    const before = await feed();
    expect(before.status).toBe(200);
    expect(before.headers['content-type']).toMatch(/application\/xml/);
    // The store's id works where its slug does, as on the other public routes.
    expect((await request(app).get(`/api/v1/feeds/${wid}/meta.csv`)).status).toBe(200);

    expect((await suspend(admin, wid)).status).toBe(200);
    const during = await feed();
    expect(during.status).toBe(423);
    expect(during.body.error.code).toBe('STORE_UNAVAILABLE');
    expect(during.text).not.toContain('Feed Lamp');
    expect((await request(app).get(`/api/v1/feeds/${wid}/meta.csv`)).status).toBe(423);

    expect((await reactivate(admin, wid)).status).toBe(200);
    expect((await feed()).status).toBe(200);
  });

  it('answers 404 for a store that does not exist, a feed that is off and a channel that is not one', async () => {
    const { wid, H } = await setup();
    const slug = (await db.Workspace.findByPk(wid)).slug;
    expect((await request(app).get('/api/v1/feeds/no-such-store/meta.xml')).status).toBe(404);
    expect((await request(app).get(`/api/v1/feeds/${slug}/meta.xml`)).status).toBe(404);
    await request(app).put(`/api/v1/workspaces/${wid}/offers/feed`).set(H).send({ enabled: true }).expect(200);
    expect((await request(app).get(`/api/v1/feeds/${slug}/nope.xml`)).status).toBe(404);
  });
});

describe('manual store suspension', () => {
  it('is kept to workspaces.manage and needs a reason', async () => {
    const { wid } = await setup();
    const agent = await makePlatformUser('agent');
    expect((await suspend(agent, wid)).status).toBe(403);

    const viewer = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['workspaces.view'] }, { where: { id: viewer.userId } });
    expect((await suspend(viewer, wid)).status).toBe(403);
    expect((await request(app).get(`/api/v1/admin/workspaces/${wid}/access`).set(viewer.H)).status).toBe(200);

    const admin = await makePlatformUser('admin');
    expect((await suspend(admin, wid, {})).status).toBe(422);
    expect((await suspend(admin, wid, { reason: '   ' })).status).toBe(422);
    expect((await db.Workspace.findByPk(wid)).status).toBe('active');
  });

  it('restricts the store without touching its subscription, and is audited', async () => {
    const { wid, H } = await setup();
    const admin = await makePlatformUser('admin');
    const subBefore = await db.Subscription.findOne({ where: { workspaceId: wid } });

    const res = await suspend(admin, wid);
    expect(res.status).toBe(200);
    expect(res.body.access).toMatchObject({
      restricted: true,
      reasons: ['suspended'],
      suspension: { suspended: true, suspensionReason: 'Chargeback investigation', suspendedBy: { id: admin.userId } },
      billing: { phase: 'ok' },
    });

    // Storefront unavailable; creation locked with its own code.
    const store = await request(app).get(`/api/v1/store/${wid}`);
    expect(store.status).toBe(423);
    expect(store.body.error.code).toBe('STORE_UNAVAILABLE');
    const blocked = await createProduct(wid, H);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('STORE_SUSPENDED');
    expect((await request(app).post(`/api/v1/workspaces/${wid}/funnels`).set(H).send({ name: 'F' })).body.error.code).toBe(
      'STORE_SUSPENDED'
    );
    // The rest of the dashboard keeps working.
    expect((await request(app).get(`/api/v1/workspaces/${wid}/catalog/products`).set(H)).status).toBe(200);
    expect((await request(app).get(`/api/v1/workspaces/${wid}/orders`).set(H)).status).toBe(200);

    // The merchant is told it is suspended, never why.
    expect(await merchantAccess(wid, H)).toMatchObject({ restricted: true, reasons: ['suspended'], suspension: { suspended: true } });
    const list = await request(app).get('/api/v1/workspaces').set(H);
    expect(JSON.stringify(list.body)).not.toContain('Chargeback');

    const subAfter = await db.Subscription.findOne({ where: { workspaceId: wid } });
    expect(subAfter.status).toBe(subBefore.status);
    expect(new Date(subAfter.currentPeriodEnd).getTime()).toBe(new Date(subBefore.currentPeriodEnd).getTime());

    const [audit] = await db.AuditLog.findAll({ where: { action: 'workspace.suspend' } });
    expect(audit).toMatchObject({
      actorUserId: admin.userId,
      workspaceId: null,
      entityType: 'Workspace',
      entityId: wid,
      beforeState: { status: 'active' },
      afterState: { status: 'suspended' },
      metadata: { workspaceId: wid, reason: 'Chargeback investigation' },
    });

    expect((await suspend(admin, wid)).body.error.code).toBe('WORKSPACE_ALREADY_SUSPENDED');
  });

  it('reactivating lifts the suspension, leaves billing alone, and is audited', async () => {
    const { wid, H } = await setup();
    const admin = await makePlatformUser('admin');
    await suspend(admin, wid);

    const res = await reactivate(admin, wid, { reason: 'Investigation closed' });
    expect(res.status).toBe(200);
    expect(res.body.access).toMatchObject({ restricted: false, reasons: [], suspension: { suspended: false, suspensionReason: null } });
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(200);
    expect((await createProduct(wid, H)).status).toBe(201);

    const [audit] = await db.AuditLog.findAll({ where: { action: 'workspace.reactivate' } });
    expect(audit).toMatchObject({
      actorUserId: admin.userId,
      metadata: { workspaceId: wid, reason: 'Investigation closed', suspensionReason: 'Chargeback investigation' },
    });
    expect((await reactivate(admin, wid)).body.error.code).toBe('WORKSPACE_NOT_SUSPENDED');
  });

  it('keeps a store restricted while either reason holds', async () => {
    const { wid, H } = await setup();
    const admin = await makePlatformUser('admin');
    // Unpaid past its grace day AND suspended.
    await db.Subscription.update(
      { status: 'past_due', currentPeriodEnd: new Date(Date.now() - 3 * DAY_MS) },
      { where: { workspaceId: wid } }
    );
    await suspend(admin, wid);
    expect((await merchantAccess(wid, H)).reasons.sort()).toEqual(['billing', 'suspended']);
    // Suspension is reported first: paying would not lift it.
    expect((await createProduct(wid, H)).body.error.code).toBe('STORE_SUSPENDED');

    // Reactivating alone leaves the billing restriction.
    await reactivate(admin, wid);
    let access = await merchantAccess(wid, H);
    expect(access).toMatchObject({ restricted: true, reasons: ['billing'] });
    expect((await createProduct(wid, H)).body.error.code).toBe('SUBSCRIPTION_REQUIRED');

    // Suspended again; paying alone leaves the suspension.
    await suspend(admin, wid);
    const charge = (await request(app).post(`/api/v1/admin/workspaces/${wid}/charges`).set(admin.H)).body.charge;
    await request(app).post(`/api/v1/admin/charges/${charge.id}/record-payment`).set(admin.H).send({ amountReceived: 29900 });
    access = await merchantAccess(wid, H);
    expect(access).toMatchObject({ restricted: true, reasons: ['suspended'] });
    expect((await db.Workspace.findByPk(wid)).status).toBe('suspended');
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(423);
  });

  it('shows the suspension on the admin workspace list, apart from billing', async () => {
    const { wid } = await setup();
    const admin = await makePlatformUser('admin');
    await suspend(admin, wid);
    const res = await request(app).get('/api/v1/admin/workspaces').set(admin.H);
    const row = res.body.workspaces.find((w) => w.id === wid);
    expect(row).toMatchObject({ status: 'suspended', suspended: true, billingPhase: 'ok', restricted: true });
    expect(row.subscriptionStatus).toBe('trialing');
  });
});
