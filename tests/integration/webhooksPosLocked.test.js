'use strict';

// Locked orders (ORDERS_LOCK_ENABLED, orders/orderLock) and what this branch
// adds around orders: the accepted-orders feed and its receipts, the kitchen
// status, order.accepted, and stored webhook deliveries.
//   feed       a locked order comes with its customer's details hidden and
//              contactLocked, as in GET /orders; a store that renews gets a
//              new ETag; receipts and the kitchen status carry no customer
//   webhooks   order.accepted is not sent while the order is locked, and goes
//              once when it opens; a stored delivery about an order locked
//              since is not sent (retry, Redeliver, Resend) and shows hidden
//              in the log

const http = require('http');
const { app, request } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { runOnce } = require('../../src/modules/webhooks/webhookWorker');
const { RECHECK_MS } = require('../../src/modules/webhooks/orderChangeDetector');
const { handleDomainEvent } = require('../../src/modules/webhooks/webhookFanout');
const h = require('../helpers/lockedStores');

h.switchOn();

const savedAck = env.publicApi.ack;
let receiver;
let clock;
beforeEach(async () => {
  env.publicApi.ack = true;
  clock = Date.now() + 1000;
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
  env.publicApi.ack = savedAck;
  await receiver.close();
});

// Each pass a little later than the last, past the hold's recheck interval.
const pass = () => {
  clock += RECHECK_MS + 5000;
  return runOnce({ now: new Date(clock) });
};
const api = (store, method, path) => request(app)[method](`/api/v1/workspaces/${store.wid}${path}`).set(h.bearer(store.token));

async function mint(store, scopes) {
  const res = await api(store, 'post', '/api-keys').send({ name: scopes.join(' '), scopes });
  if (res.status !== 201) throw new Error(`mint ${res.status} ${JSON.stringify(res.body)}`);
  return h.bearer(res.body.secret);
}

async function addEndpoint(store, path, events) {
  const res = await api(store, 'post', '/webhooks').send({ url: `${receiver.base}${path}`, events });
  if (res.status !== 201) throw new Error(`endpoint ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.endpoint;
}

/** A dashboard order paid by card (captured): accepted, and locked while the store cannot pay its fee. */
async function paidByCard(store) {
  const order = await h.placed(store, { paymentMethod: 'card' });
  const init = await api(store, 'post', `/orders/${order.id}/payments`).send({});
  const captured = await api(store, 'post', `/payments/${init.body.payment.id}/capture`).send({});
  if (captured.status !== 200) throw new Error(`capture ${captured.status} ${JSON.stringify(captured.body)}`);
  return order;
}

const SECRETS = [h.CONTACT.fullName, h.CONTACT.phone, h.CONTACT.email, h.ADDRESS.addressLine];
const expectNoCustomer = (value) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
};

describe('the accepted-orders feed and a locked order', () => {
  it('lists it hidden with contactLocked, its receipt and kitchen status carry no customer, and a renewal changes the ETag', async () => {
    const store = await h.monthlyStore({ lapsed: true });
    const till = await mint(store, ['orders:read', 'orders:pos_status']);
    const order = await paidByCard(store);
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('due');

    const feed = (headers = {}) => request(app).get('/api/v1/public/orders/accepted').set(till).set(headers);
    const locked = await feed();
    expect(locked.status).toBe(200);
    const listed = locked.body.orders.find((o) => o.id === order.id);
    expect(listed).toMatchObject({ contactLocked: true, acceptedVia: 'payment' });
    expect(listed.contact.fullName).toBe('••••');
    expect(listed.items).toHaveLength(1);
    expectNoCustomer(locked.body);

    // Nothing changed: 304. Renewed — no order written — the same order opens, and the ETag moves.
    expect((await feed({ 'If-None-Match': locked.headers.etag })).status).toBe(304);
    await h.renew(store);
    const open = await feed({ 'If-None-Match': locked.headers.etag });
    expect(open.status).toBe(200);
    const opened = open.body.orders.find((o) => o.id === order.id);
    expect(opened.contactLocked).toBeUndefined();
    expect(opened.contact.fullName).toBe(h.CONTACT.fullName);

    // Lapsed again: the receipt and the kitchen status work on a locked order and answer no customer detail.
    await h.lapse(store);
    const status = await request(app).put(`/api/v1/public/orders/${order.id}/pos-status`).set(till).send({ status: 'preparing' });
    expect(status.status).toBe(200);
    expectNoCustomer(status.body);
    const ack = await request(app).post(`/api/v1/public/orders/${order.id}/ack`).set(till);
    expect(ack.status).toBe(200);
    expect(Object.keys(ack.body.ack).sort()).toEqual(['ackedAt', 'orderId']);
  });
});

describe('the accepted-orders export and a locked order', () => {
  it('lists it with the customer hidden, as the orders list does', async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    const order = await paidByCard(store);
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('due');
    const today = new Date().toISOString().slice(0, 10);
    const binary = (res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const res = await api(store, 'get', `/orders/export?preset=accepted&from=${today}&to=${today}&format=csv&lang=en`).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const text = res.body.toString('utf8');
    expect(text).toContain(order.orderNumber);
    expect(text).toContain('••••');
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe('order.accepted and a locked order', () => {
  it('is not sent while the order is locked, and goes once, in full, when it opens', async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    await addEndpoint(store, '/kitchen', ['order.accepted']);
    const order = await paidByCard(store);
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('due');
    // The payment's own events, handed to the fan-out while it is locked, and the scanner's passes: nothing.
    for (const type of ['order.paid', 'order.confirmed']) await handleDomainEvent({ id: null, type, workspaceId: store.wid, payload: { orderId: order.id } });
    await pass();
    await pass();
    expect(receiver.received).toHaveLength(0);
    expect(await db.WebhookDelivery.count({ where: { eventType: 'order.accepted', workspaceId: store.wid } })).toBe(0);

    await h.topUp(store, h.FEE * 2);
    await api(store, 'post', '/orders/locked/settle').send({});
    await pass();
    await pass();
    const accepted = receiver.received.filter((r) => r.json.type === 'order.accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0].json.id).toBe(`order.accepted:${order.id}`);
    expect(accepted[0].json.data).toMatchObject({ acceptedVia: 'payment', order: { id: order.id, contact: { fullName: h.CONTACT.fullName } } });
  });
});

describe('a stored delivery about an order locked since', () => {
  it('is not sent again — retry, Redeliver, Resend — and shows hidden in the log', async () => {
    const store = await h.payPerOrderStore({ balance: h.FEE });
    const endpoint = await addEndpoint(store, '/hooks', ['order.created']);
    const first = await h.placed(store, { contact: { fullName: 'Paid Buyer', phone: '01000006666', email: 'paid@example.com' } });
    const second = await h.placed(store);
    await pass();
    expect(receiver.received.filter((r) => r.json.data.order.id === second.id)).toHaveLength(1);

    // The balance pays the first order's fee: the second, still pending, is locked from now on.
    expect((await h.confirm(store, first.id)).status).toBe(200);
    const row = (await db.WebhookDelivery.findAll({ where: { endpointId: endpoint.id } })).find((d) => d.payload.data.order.id === second.id);

    const redeliver = await api(store, 'post', `/webhooks/${endpoint.id}/deliveries/${row.id}/redeliver`);
    expect([redeliver.status, redeliver.body.error.code]).toEqual([402, 'ORDER_LOCKED']);
    const resend = await api(store, 'post', `/webhooks/deliveries/${row.id}/resend`);
    expect([resend.status, resend.body.error.code]).toEqual([402, 'ORDER_LOCKED']);

    // A retry that comes due is not sent either: the row stops, saying why.
    await row.update({ status: 'failed', nextAttemptAt: new Date(clock) });
    await pass();
    expect(receiver.received.filter((r) => r.json.data.order.id === second.id)).toHaveLength(1);
    await row.reload();
    expect(row.status).toBe('failed');
    expect(row.nextAttemptAt).toBeNull();
    expect(row.lastError).toMatch(/locked/);

    // The log: the locked order's row hidden for everyone, the open one as it was.
    for (const path of [`/webhooks/deliveries`, `/webhooks/${endpoint.id}/deliveries`]) {
      const log = await api(store, 'get', path);
      expect(log.status).toBe(200);
      const lockedRow = log.body.deliveries.find((d) => d.id === row.id);
      expect(lockedRow.contactLocked).toBe(true);
      expect(lockedRow.payload.data.order.contact.fullName).toBe('••••');
      expect(lockedRow.payload.data.order.shippingAddress).toMatchObject({ country: 'EG', province: 'Giza', addressLine: '••••' });
      expectNoCustomer(lockedRow);
      const openRow = log.body.deliveries.find((d) => d.payload.data.order.id === first.id);
      expect(openRow.contactLocked).toBeUndefined();
      expect(openRow.payload.data.order.contact.fullName).toBe('Paid Buyer');
    }
  });
});
