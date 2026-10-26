'use strict';

// An automation's webhook step and the customer (automations/automationSteps.js,
// webhooks/customerData.js, migration 722): it sends the customer's name and
// the order's tracking and recovery links in full only while the teammate who
// last saved the rule's steps holds customers.reveal_sensitive — the rule
// webhook endpoints follow. And a rule's first webhook step needs api_access
// while WEBHOOKS_REQUIRE_API_ACCESS and PLAN_FEATURE_ENFORCEMENT are on.

const crypto = require('crypto');
const http = require('http');
const { Sequelize } = require('sequelize');
const { app, request, setupWorkspaceWithProduct, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { trigger } = require('../../src/modules/automations/automationExecutor');
const migration722 = require('../../src/db/migrations/722-automation-rule-configurer');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const saved = { gate: env.webhooks.requireApiAccess, enforcement: env.planFeatures.enforcement };

let receiver;
beforeEach(async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ path: req.url, json: JSON.parse(body) });
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiver = { base: `http://127.0.0.1:${server.address().port}`, received, close: () => new Promise((d) => server.close(d)) };
});
afterEach(async () => {
  env.webhooks.requireApiAccess = saved.gate;
  env.planFeatures.enforcement = saved.enforcement;
  await receiver.close();
});

async function setup() {
  const ctx = await setupWorkspaceWithProduct();
  ctx.manager = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'workspace_manager', 'Store Manager');
  ctx.rules = `/api/v1/workspaces/${ctx.workspace.id}/automations`;
  return ctx;
}

const rule = (ctx, token, path) =>
  request(app)
    .post(ctx.rules)
    .set(bearer(token))
    .send({ name: `Hook ${path}`, trigger: 'order.created', isActive: true, actions: [{ type: 'webhook', url: `${receiver.base}${path}` }] });

let seq = 0;
async function placeOrder(ctx) {
  seq += 1;
  const res = await request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
    .set(bearer(ctx.auth.accessToken))
    .set('Idempotency-Key', `aw-${Date.now()}-${seq}`)
    .send({
      items: [{ variantId: ctx.variant.id, quantity: 1 }],
      contact: { fullName: 'Mona Adel', phone: '01001234567' },
      shippingAddress: { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '9 Abbas El Akkad St' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`order ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

describe("an automation's webhook step and the customer", () => {
  it('sends the name and links in full for a rule the owner saved, masked for one the manager saved; saving the steps decides', async () => {
    const ctx = await setup();
    const byOwner = (await rule(ctx, ctx.auth.accessToken, '/owner')).body.rule;
    const byManager = (await rule(ctx, ctx.manager.accessToken, '/manager')).body.rule;
    const order = await placeOrder(ctx);
    await trigger(ctx.workspace.id, 'order.created', { orderId: order.id });

    const owner = receiver.received.find((r) => r.path === '/owner');
    const manager = receiver.received.find((r) => r.path === '/manager');
    expect(owner.json.data.customer_name).toBe('Mona Adel');
    expect(manager.json.data.customer_name).toBe('M*** A***');
    expect(manager.json.data.order_link).toBe('');
    expect(manager.json.data).toMatchObject({ order_number: owner.json.data.order_number, city: 'Nasr City' });
    expect(JSON.stringify(manager.json)).not.toContain('Mona Adel');

    // The owner saving the manager's steps makes it send in full; renaming it alone does not change whose role counts.
    await request(app).patch(`${ctx.rules}/${byManager.id}`).set(bearer(ctx.auth.accessToken)).send({ actions: [{ type: 'webhook', url: `${receiver.base}/manager` }] });
    await request(app).patch(`${ctx.rules}/${byOwner.id}`).set(bearer(ctx.manager.accessToken)).send({ name: 'Renamed by the manager' });
    const second = await placeOrder(ctx);
    await trigger(ctx.workspace.id, 'order.created', { orderId: second.id });
    const latest = (path) => receiver.received.filter((r) => r.path === path).pop();
    expect(latest('/manager').json.data.customer_name).toBe('Mona Adel');
    expect(latest('/owner').json.data.customer_name).toBe('Mona Adel');
  });

  it("a rule's first webhook step needs api_access while the gate and enforcement are on; one that has it keeps editing", async () => {
    const ctx = await setup();
    const plan = await db.Plan.create({ key: `aw${crypto.randomBytes(4).toString('hex')}`, name: 'No API', currency: 'EGP', monthlyPriceAmount: 0, yearlyPriceAmount: 0, trialDays: 14, isActive: true, isPublic: true, features: [] });
    await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: ctx.workspace.id } });
    const existing = (await rule(ctx, ctx.auth.accessToken, '/before')).body.rule;
    const tagOnly = (
      await request(app)
        .post(ctx.rules)
        .set(bearer(ctx.auth.accessToken))
        .send({ name: 'Tag', trigger: 'order.created', isActive: true, actions: [{ type: 'add_tag', tag: 'new' }] })
    ).body.rule;

    env.webhooks.requireApiAccess = true;
    env.planFeatures.enforcement = true;
    const refused = await rule(ctx, ctx.auth.accessToken, '/new');
    expect([refused.status, refused.body.error.code]).toEqual([403, 'PLAN_FEATURE_REQUIRED']);
    const added = await request(app).patch(`${ctx.rules}/${tagOnly.id}`).set(bearer(ctx.auth.accessToken)).send({ actions: [{ type: 'webhook', url: `${receiver.base}/added` }] });
    expect(added.status).toBe(403);
    // A rule that already sends to a URL: its address changes on any plan.
    const moved = await request(app).patch(`${ctx.rules}/${existing.id}`).set(bearer(ctx.auth.accessToken)).send({ actions: [{ type: 'webhook', url: `${receiver.base}/moved` }] });
    expect(moved.status).toBe(200);
  });

  it('migration 722 backfills the configurer from the activity log: the creator, or the latest editor of the steps', async () => {
    const ctx = await setup();
    const kept = (await rule(ctx, ctx.auth.accessToken, '/kept')).body.rule;
    const moved = (await rule(ctx, ctx.auth.accessToken, '/moved')).body.rule;
    await request(app).patch(`${ctx.rules}/${kept.id}`).set(bearer(ctx.manager.accessToken)).send({ name: 'Renamed' });
    await request(app).patch(`${ctx.rules}/${moved.id}`).set(bearer(ctx.manager.accessToken)).send({ actions: [{ type: 'webhook', url: `${receiver.base}/elsewhere` }] });
    const owner = await db.Membership.findOne({ where: { workspaceId: ctx.workspace.id, userId: { [Sequelize.Op.ne]: ctx.manager.userId } } });

    await db.AutomationRule.update({ configuredByUserId: null }, { where: { workspaceId: ctx.workspace.id } });
    await migration722.up(db.sequelize.getQueryInterface(), Sequelize);

    expect((await db.AutomationRule.findByPk(kept.id)).configuredByUserId).toBe(owner.userId);
    expect((await db.AutomationRule.findByPk(moved.id)).configuredByUserId).toBe(ctx.manager.userId);
  });
});
