'use strict';

// order.accepted (orders/orderAccepted.js, webhooks/webhookFanout.js): a COD
// order when it is confirmed, an online order when it is paid, once per
// order and endpoint, only to endpoints that list it — never through '*' —
// and only within the order's own store.

const http = require('http');
const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const { runOnce } = require('../../src/modules/webhooks/webhookWorker');
const { handleDomainEvent } = require('../../src/modules/webhooks/webhookFanout');
const { acceptanceOf } = require('../../src/modules/orders/orderAccepted');

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
  receiver = { base: `http://127.0.0.1:${server.address().port}`, received, close: () => new Promise((done) => server.close(done)) };
});
afterEach(async () => {
  await receiver.close();
});

async function addEndpoint(ctx, path, events) {
  const res = await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/webhooks`).set(bearer(ctx.auth.accessToken)).send({ url: `${receiver.base}${path}`, events });
  if (res.status !== 201) throw new Error(`addEndpoint ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.endpoint;
}

async function placeOrder(ctx, paymentMethod = 'cod') {
  const res = await request(app)
    .post(`/api/v1/workspaces/${ctx.workspace.id}/orders`)
    .set(bearer(ctx.auth.accessToken))
    .set('Idempotency-Key', `acc-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId: ctx.variant.id, quantity: 1 }],
      contact: { fullName: 'Accepted Buyer', phone: '01000005555' },
      shippingAddress: { country: 'EG', city: 'Giza', addressLine: '9 Nile St' },
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const acceptedRows = (endpointId) => db.WebhookDelivery.findAll({ where: { endpointId, eventType: 'order.accepted' } });

/** The outbox runs consumers right after the commit under test; give that a moment. */
async function eventually(check, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

describe('order.accepted', () => {
  it('is in the catalogue, and an endpoint may list it beside "*"', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const both = await addEndpoint(ctx, '/both', ['*', 'order.accepted', 'order.created']);
    expect(both.events).toEqual(['*', 'order.accepted']);
    const events = await request(app).get(`/api/v1/workspaces/${ctx.workspace.id}/webhooks/events`).set(bearer(ctx.auth.accessToken));
    expect(events.body.events.map((e) => e.name)).toContain('order.accepted');
    expect(events.body.explicitOnly).toEqual(['order.accepted']);
  });

  it('COD: sent on confirmation to the endpoints that list it, not to "*", once, and not again when the cash is collected', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const listing = await addEndpoint(ctx, '/accepted', ['order.accepted']);
    const wildcard = await addEndpoint(ctx, '/all', ['*']);
    const both = await addEndpoint(ctx, '/both', ['*', 'order.accepted']);
    const order = await placeOrder(ctx);
    expect((await acceptanceOf(ctx.workspace.id, order.id)).accepted).toBe(false);

    await confirmCodOrder(ctx.auth.accessToken, ctx.workspace.id, order.id);
    expect(await eventually(async () => (await acceptedRows(listing.id)).length === 1)).toBe(true);
    expect(await eventually(async () => (await acceptedRows(both.id)).length === 1)).toBe(true);
    expect(await acceptedRows(wildcard.id)).toHaveLength(0);

    await runOnce();
    const hits = receiver.received.filter((r) => r.json.type === 'order.accepted');
    expect(hits.map((h) => h.path).sort()).toEqual(['/accepted', '/both']);
    expect(hits[0].json).toMatchObject({
      id: `order.accepted:${order.id}`,
      type: 'order.accepted',
      workspaceId: ctx.workspace.id,
      data: { acceptedVia: 'confirmation', order: { id: order.id, orderNumber: order.orderNumber, confirmationState: 'confirmed' } },
    });
    expect(hits[0].json.data.acceptedAt).toBeTruthy();

    // The same order confirmed "again" and its cash collected: nothing more.
    const event = { id: null, workspaceId: ctx.workspace.id, payload: { orderId: order.id } };
    await handleDomainEvent({ ...event, type: 'order.confirmed' });
    await db.Order.update({ financialState: 'paid' }, { where: { id: order.id } });
    await handleDomainEvent({ ...event, type: 'order.paid' });
    expect(await acceptedRows(listing.id)).toHaveLength(1);
  });

  it('online: sent when paid, never on a confirmation, and not for a cancelled order', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const listing = await addEndpoint(ctx, '/accepted', ['order.accepted']);
    const order = await placeOrder(ctx, 'card');
    const event = { id: null, workspaceId: ctx.workspace.id, payload: { orderId: order.id } };

    await handleDomainEvent({ ...event, type: 'order.paid' });
    expect(await acceptedRows(listing.id)).toHaveLength(0);

    // Paid with no completed_at (no moment to stand on): not counted as accepted.
    await db.Order.update({ financialState: 'paid', completedAt: null }, { where: { id: order.id } });
    expect((await acceptanceOf(ctx.workspace.id, order.id)).accepted).toBe(false);

    await db.Order.update({ financialState: 'paid', completedAt: new Date() }, { where: { id: order.id } });
    await handleDomainEvent({ ...event, type: 'order.confirmed' });
    expect(await acceptedRows(listing.id)).toHaveLength(0);
    await handleDomainEvent({ ...event, type: 'order.paid' });
    const [row] = await acceptedRows(listing.id);
    expect(row.payload.data).toMatchObject({ acceptedVia: 'payment', order: { id: order.id } });

    await db.Order.update({ cancelledAt: new Date() }, { where: { id: order.id } });
    expect((await acceptanceOf(ctx.workspace.id, order.id)).accepted).toBe(false);
  });

  it('is not sent as accepted when the order was cancelled before the attempt (a receiver that was down)', async () => {
    const ctx = await setupWorkspaceWithProduct();
    const listing = await addEndpoint(ctx, '/accepted', ['order.accepted']);
    const order = await placeOrder(ctx);
    await confirmCodOrder(ctx.auth.accessToken, ctx.workspace.id, order.id);
    expect(await eventually(async () => (await acceptedRows(listing.id)).length === 1)).toBe(true);

    const cancel = await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${order.id}/cancel`).set(bearer(ctx.auth.accessToken)).send({ reason: 'Customer called to cancel' });
    expect(cancel.status).toBe(200);
    await runOnce();

    expect(receiver.received.filter((r) => r.json.type === 'order.accepted')).toEqual([]);
    const [row] = await acceptedRows(listing.id);
    expect(row.status).toBe('exhausted');
    expect(row.lastError).toMatch(/no longer accepted/);
  });

  it("never reaches another store's endpoint", async () => {
    const a = await setupWorkspaceWithProduct();
    const b = await setupWorkspaceWithProduct();
    const hookB = await addEndpoint(b, '/b', ['order.accepted']);
    const order = await placeOrder(a);
    await confirmCodOrder(a.auth.accessToken, a.workspace.id, order.id);
    // B's endpoint is asked about A's order directly too: nothing.
    await handleDomainEvent({ id: null, type: 'order.confirmed', workspaceId: b.workspace.id, payload: { orderId: order.id } });
    expect(await acceptedRows(hookB.id)).toHaveLength(0);
  });
});
