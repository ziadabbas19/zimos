'use strict';

// WEBHOOKS_MAX_PAYLOAD_BYTES end to end: an order event over the cap reaches
// the receiver signed, with the order's id and number and `truncated: true`,
// and the delivery log keeps that same reduced body.

const http = require('http');
const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { runOnce } = require('../../src/modules/webhooks/webhookWorker');
const { verifySignature } = require('../../src/modules/webhooks/webhookSigning');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const savedMax = env.webhooks.maxPayloadBytes;

let receiver;
beforeEach(async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, body, json: JSON.parse(body) });
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  receiver = { url: `http://127.0.0.1:${server.address().port}/hooks`, received, close: () => new Promise((done) => server.close(done)) };
});
afterEach(async () => {
  env.webhooks.maxPayloadBytes = savedMax;
  await receiver.close();
});

it('sends an order over the cap as ids only, signed, and logs the same body', async () => {
  env.webhooks.maxPayloadBytes = 900;
  const { auth, workspace, variant } = await setupWorkspaceWithProduct();
  const hook = await request(app).post(`/api/v1/workspaces/${workspace.id}/webhooks`).set(bearer(auth.accessToken)).send({ url: receiver.url, events: ['order.created'] });
  const order = (
    await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/orders`)
      .set(bearer(auth.accessToken))
      .set('Idempotency-Key', `cap-${Date.now()}`)
      .send({
        items: [{ variantId: variant.id, quantity: 1 }],
        contact: { fullName: 'Cap Buyer', phone: '01000004444' },
        shippingAddress: { country: 'EG', city: 'Giza', addressLine: '3 Pyramids Rd' },
        paymentMethod: 'cod',
        notes: 'n'.repeat(1500),
      })
  ).body.order;

  await runOnce();
  expect(receiver.received).toHaveLength(1);
  const [hit] = receiver.received;
  expect(verifySignature(hook.body.signingSecret, hit.headers['x-zimos-signature'], hit.body)).toBe(true);
  expect(Buffer.byteLength(hit.body)).toBeLessThanOrEqual(900);
  expect(hit.json).toMatchObject({ id: `order.created:${order.id}`, type: 'order.created', truncated: true, data: { order: { id: order.id, orderNumber: order.orderNumber } } });
  expect(hit.json.data.order.notes).toBeUndefined();

  const logged = await db.WebhookDelivery.findOne({ where: { endpointId: hook.body.endpoint.id } });
  expect(logged.payload).toEqual(hit.json);
});

it('leaves every order whole when no cap is set (the default)', async () => {
  expect(env.webhooks.maxPayloadBytes).toBe(0);
  const { auth, workspace, variant } = await setupWorkspaceWithProduct();
  await request(app).post(`/api/v1/workspaces/${workspace.id}/webhooks`).set(bearer(auth.accessToken)).send({ url: receiver.url, events: ['order.created'] });
  await request(app)
    .post(`/api/v1/workspaces/${workspace.id}/orders`)
    .set(bearer(auth.accessToken))
    .set('Idempotency-Key', `cap-whole-${Date.now()}`)
    .send({ items: [{ variantId: variant.id, quantity: 1 }], contact: { fullName: 'Whole Buyer', phone: '01000004445' }, shippingAddress: { country: 'EG', city: 'Giza', addressLine: '4 Pyramids Rd' }, paymentMethod: 'cod' });
  await runOnce();
  expect(receiver.received[0].json.truncated).toBeUndefined();
  expect(receiver.received[0].json.data.order.items).toHaveLength(1);
});
