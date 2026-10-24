'use strict';

// Customers in webhooks follow customers.reveal_sensitive (webhooks/customerData.js):
// an endpoint is sent names, phones, emails and street addresses in full only
// while the teammate who last set its address holds the permission; the
// delivery log shows them in full only to a viewer who holds it; resending
// past orders needs it. A Workspace Manager (webhooks.manage, no reveal) can
// no longer pull customers through a webhook of their own.

const http = require('http');
const { Sequelize } = require('sequelize');
const { app, request, setupWorkspaceWithProduct, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const { runOnce } = require('../../src/modules/webhooks/webhookWorker');
const migration719 = require('../../src/db/migrations/719-webhook-configurer-and-feed-index');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

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
  await receiver.close();
});

let seq = 0;
async function placeOrder(ctx) {
  seq += 1;
  const res = await request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
    .set(bearer(ctx.auth.accessToken))
    .set('Idempotency-Key', `cd-${Date.now()}-${seq}`)
    .send({
      items: [{ variantId: ctx.variant.id, quantity: 1 }],
      contact: { fullName: 'Mona Adel', phone: '01001234567', email: 'mona.adel@example.com' },
      shippingAddress: { country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '9 Abbas El Akkad St, flat 4', notes: 'Ring twice' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`order ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function setup() {
  const ctx = await setupWorkspaceWithProduct();
  ctx.manager = await addMemberWithRole(ctx.auth.accessToken, ctx.workspace.id, 'workspace_manager', 'Store Manager');
  ctx.hooks = `/api/v1/workspaces/${ctx.workspace.id}/webhooks`;
  return ctx;
}

const addEndpoint = async (ctx, token, path) => {
  const res = await request(app).post(ctx.hooks).set(bearer(token)).send({ url: `${receiver.base}${path}`, events: ['order.created'] });
  if (res.status !== 201) throw new Error(`endpoint ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.endpoint;
};

const contactOf = (hit) => hit.json.data.order.contact;

describe('customers in webhook deliveries', () => {
  it('an endpoint set up by a teammate without reveal_sensitive is sent customers masked; one set up by the owner in full', async () => {
    const ctx = await setup();
    const byManager = await addEndpoint(ctx, ctx.manager.accessToken, '/manager');
    const byOwner = await addEndpoint(ctx, ctx.auth.accessToken, '/owner');
    expect(byManager.sendsCustomerData).toBe(false);
    expect(byOwner.sendsCustomerData).toBe(true);

    await placeOrder(ctx);
    await runOnce();
    const manager = receiver.received.find((r) => r.path === '/manager');
    const owner = receiver.received.find((r) => r.path === '/owner');

    expect(contactOf(owner)).toMatchObject({ fullName: 'Mona Adel', phone: expect.stringMatching(/1234567$/), email: 'mona.adel@example.com' });
    expect(owner.json.data.order.shippingAddress.addressLine).toBe('9 Abbas El Akkad St, flat 4');

    const text = JSON.stringify(manager.json);
    for (const secret of ['Mona Adel', '1234567', 'mona.adel@', 'Abbas El Akkad', 'Ring twice']) expect(text).not.toContain(secret);
    expect(contactOf(manager)).toMatchObject({ fullName: 'M*** A***', email: 'm***@example.com' });
    expect(contactOf(manager).phone).toMatch(/\*/);
    // Where the parcel goes stays: country, governorate and city.
    expect(manager.json.data.order.shippingAddress).toMatchObject({ country: 'EG', province: 'Cairo', city: 'Nasr City', addressLine: '••••' });
    // The order itself is whole: number, lines, amounts.
    expect(manager.json.data.order.items).toHaveLength(1);
    expect(manager.json.data.order.amounts.total).toBe(owner.json.data.order.amounts.total);
  });

  it('the owner setting the address again makes it send in full; a configurer gone or unknown sends masked', async () => {
    const ctx = await setup();
    const endpoint = await addEndpoint(ctx, ctx.manager.accessToken, '/hook');
    const resaved = await request(app).patch(`${ctx.hooks}/${endpoint.id}`).set(bearer(ctx.auth.accessToken)).send({ url: `${receiver.base}/hook` });
    expect(resaved.body.endpoint.sendsCustomerData).toBe(true);
    await placeOrder(ctx);
    await runOnce();
    expect(contactOf(receiver.received[0]).fullName).toBe('Mona Adel');

    // Only editing its events or pausing it does not change whose role counts.
    const paused = await request(app).patch(`${ctx.hooks}/${endpoint.id}`).set(bearer(ctx.manager.accessToken)).send({ isActive: true, events: ['order.created', 'order.status_changed'] });
    expect(paused.body.endpoint.sendsCustomerData).toBe(true);

    await db.WebhookEndpoint.update({ configuredByUserId: null }, { where: { id: endpoint.id } });
    await placeOrder(ctx);
    await runOnce();
    expect(contactOf(receiver.received[1]).fullName).toBe('M*** A***');
  });

  it('the delivery log shows customers in full only to a viewer who may see them', async () => {
    const ctx = await setup();
    const endpoint = await addEndpoint(ctx, ctx.auth.accessToken, '/owner');
    await placeOrder(ctx);
    await runOnce();

    const asOwner = await request(app).get(`${ctx.hooks}/${endpoint.id}/deliveries`).set(bearer(ctx.auth.accessToken));
    expect(JSON.stringify(asOwner.body)).toContain('Mona Adel');

    for (const path of [`${ctx.hooks}/${endpoint.id}/deliveries`, `${ctx.hooks}/deliveries`]) {
      const asManager = await request(app).get(path).set(bearer(ctx.manager.accessToken));
      expect(asManager.status).toBe(200);
      const text = JSON.stringify(asManager.body);
      expect(text).not.toContain('Mona Adel');
      expect(text).not.toContain('1234567');
      expect(text).toContain('M*** A***');
    }
  });

  it('resending past orders needs reveal_sensitive', async () => {
    const ctx = await setup();
    await addEndpoint(ctx, ctx.auth.accessToken, '/owner');
    const order = await placeOrder(ctx);
    const refused = await request(app).post(`${ctx.hooks}/resend-orders`).set(bearer(ctx.manager.accessToken)).send({ orderIds: [order.id] });
    expect(refused.status).toBe(403);
    const sent = await request(app).post(`${ctx.hooks}/resend-orders`).set(bearer(ctx.auth.accessToken)).send({ orderIds: [order.id] });
    expect(sent.status).toBe(200);
    expect(sent.body.deliveries).toBe(1);
  });

  it('migration 719 backfills the configurer from the activity log: the creator, or the latest editor of the URL', async () => {
    const ctx = await setup();
    const kept = await addEndpoint(ctx, ctx.auth.accessToken, '/kept');
    const moved = await addEndpoint(ctx, ctx.auth.accessToken, '/moved');
    // The manager pauses one (no URL change) and moves the other.
    await request(app).patch(`${ctx.hooks}/${kept.id}`).set(bearer(ctx.manager.accessToken)).send({ isActive: false });
    await request(app).patch(`${ctx.hooks}/${moved.id}`).set(bearer(ctx.manager.accessToken)).send({ url: `${receiver.base}/elsewhere` });
    const owner = await db.Membership.findOne({ where: { workspaceId: ctx.workspace.id, userId: { [Sequelize.Op.ne]: ctx.manager.userId } } });

    await db.WebhookEndpoint.update({ configuredByUserId: null }, { where: { workspaceId: ctx.workspace.id } });
    await migration719.up(db.sequelize.getQueryInterface(), Sequelize);

    expect((await db.WebhookEndpoint.findByPk(kept.id)).configuredByUserId).toBe(owner.userId);
    expect((await db.WebhookEndpoint.findByPk(moved.id)).configuredByUserId).toBe(ctx.manager.userId);
  });
});
