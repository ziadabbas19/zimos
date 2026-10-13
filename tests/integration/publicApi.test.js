'use strict';

// The public API: workspace API keys (minted in the dashboard, used as a
// Bearer token) reading orders and moving them through confirmation,
// cancellation, shipping and COD collection — through the same services the
// dashboard uses, so the same rules hold.

const express = require('express');
const { app, request, setupWorkspaceWithProduct, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');
const { createApiKeyLimiter } = require('../../src/modules/apiKeys/apiKeyAuth');
const { hashKey } = require('../../src/modules/apiKeys/apiKeyService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

async function placeOrder(token, workspaceId, variantId, { qty = 2, paymentMethod = 'cod' } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders`)
    .set(bearer(token))
    .set('Idempotency-Key', `o-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .send({
      items: [{ variantId, quantity: qty }],
      contact: { fullName: 'API Buyer', phone: '01000003333' },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '9 Nile St' },
      paymentMethod,
    });
  if (res.status !== 201) throw new Error(`placeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

async function mintKey(token, workspaceId, { scopes = ['orders:read', 'orders:write'], name = 'Fulfilment' } = {}) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/api-keys`)
    .set(bearer(token))
    .send({ name, scopes });
  if (res.status !== 201) throw new Error(`mintKey failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('API keys', () => {
  it('shows the secret once, stores only its hash, and authenticates it as a Bearer token or X-API-Key', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const { apiKey, secret } = await mintKey(auth.accessToken, workspace.id, { scopes: ['orders:read'] });

    expect(secret).toMatch(/^zk_[A-Za-z0-9]{9}_[A-Za-z0-9]{40}$/);
    expect(secret.startsWith(apiKey.keyPrefix)).toBe(true);
    expect(apiKey).not.toHaveProperty('secretHash');

    const row = await db.ApiKey.findByPk(apiKey.id);
    expect(row.secretHash).toBe(hashKey(secret));
    expect(row.secretHash).not.toContain(secret.slice(13));

    const list = await request(app).get(`/api/v1/workspaces/${workspace.id}/api-keys`).set(bearer(auth.accessToken));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(list.body.apiKeys[0].keyPrefix).toBe(apiKey.keyPrefix);

    const me = await request(app).get('/api/v1/public/me').set(bearer(secret));
    expect(me.status).toBe(200);
    expect(me.body.workspaceId).toBe(workspace.id);
    expect(me.body.apiKey.scopes).toEqual(['orders:read']);

    const alt = await request(app).get('/api/v1/public/me').set('X-API-Key', secret);
    expect(alt.status).toBe(200);

    expect((await db.ApiKey.findByPk(apiKey.id)).lastUsedAt).not.toBeNull();
  });

  it('answers every bad key with the same 401: missing, malformed, wrong secret, revoked', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const { apiKey, secret } = await mintKey(auth.accessToken, workspace.id);

    const missing = await request(app).get('/api/v1/public/me');
    expect(missing.status).toBe(401);

    const malformed = await request(app).get('/api/v1/public/me').set(bearer('not-a-key'));
    expect(malformed.status).toBe(401);
    expect(malformed.body.error.code).toBe('INVALID_API_KEY');

    const wrongSecret = `${secret.slice(0, 13)}${'x'.repeat(40)}`;
    const wrong = await request(app).get('/api/v1/public/me').set(bearer(wrongSecret));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_API_KEY');

    const revoke = await request(app)
      .delete(`/api/v1/workspaces/${workspace.id}/api-keys/${apiKey.id}`)
      .set(bearer(auth.accessToken));
    expect(revoke.status).toBe(200);
    expect(revoke.body.apiKey.revokedAt).not.toBeNull();

    const revoked = await request(app).get('/api/v1/public/me').set(bearer(secret));
    expect(revoked.status).toBe(401);
    expect(revoked.body.error.code).toBe('INVALID_API_KEY');

    const audit = await db.AuditLog.findOne({ where: { entityType: 'ApiKey', entityId: apiKey.id, action: 'api_key.revoke' } });
    expect(audit).not.toBeNull();
  });

  it('never lets a key do more than its scopes allow', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    const { secret } = await mintKey(auth.accessToken, workspace.id, { scopes: ['orders:read'] });

    const read = await request(app).get(`/api/v1/public/orders/${order.id}`).set(bearer(secret));
    expect(read.status).toBe(200);

    const write = await request(app)
      .post(`/api/v1/public/orders/${order.id}/confirmation`)
      .set(bearer(secret))
      .send({ outcome: 'confirmed' });
    expect(write.status).toBe(403);
    expect((await db.Order.findByPk(order.id)).confirmationState).toBe('pending');
  });

  it("never lets a key do more than its creator's role allows, and dies with the creator's membership", async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id);
    // A workspace manager may mint keys and manage orders, but confirming
    // COD orders is the confirmation team's permission, not theirs.
    const manager = await addMemberWithRole(auth.accessToken, workspace.id, 'workspace_manager', 'Store Manager');
    const { secret } = await mintKey(manager.accessToken, workspace.id, { scopes: ['orders:read', 'orders:write'] });

    const confirm = await request(app)
      .post(`/api/v1/public/orders/${order.id}/confirmation`)
      .set(bearer(secret))
      .send({ outcome: 'confirmed' });
    expect(confirm.status).toBe(403);

    const me = await request(app).get('/api/v1/public/me').set(bearer(secret));
    expect(me.body.actingAs.fullName).toBe('Store Manager');

    await db.Membership.destroy({ where: { workspaceId: workspace.id, userId: manager.userId } });
    const gone = await request(app).get('/api/v1/public/me').set(bearer(secret));
    expect(gone.status).toBe(401);
  });

  it("stops working while the store is suspended", async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const { secret } = await mintKey(auth.accessToken, workspace.id);
    await db.Workspace.update(
      { status: 'suspended', suspendedAt: new Date(), suspensionReason: 'Test suspension' },
      { where: { id: workspace.id } }
    );

    const res = await request(app).get('/api/v1/public/me').set(bearer(secret));
    expect(res.status).toBe(401);
  });

  it('only lets people with api_keys.manage mint keys', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const agent = await addMemberWithRole(auth.accessToken, workspace.id, 'confirmation_agent');
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspace.id}/api-keys`)
      .set(bearer(agent.accessToken))
      .send({ name: 'Mine', scopes: ['orders:read'] });
    expect(res.status).toBe(403);
  });

  it("rate-limits per key at the key's own limit", async () => {
    const mini = express();
    mini.use((req, res, next) => {
      req.apiKey = { id: 'key-1', rateLimitPerMinute: 2 };
      next();
    });
    mini.use(createApiKeyLimiter({ skip: () => false }));
    mini.get('/', (req, res) => res.json({ ok: true }));
    // The app's error handler turns the RateLimitError into its 429 body.
    mini.use(require('../../src/core/middleware/errorHandler').errorHandler);

    expect((await request(mini).get('/')).status).toBe(200);
    expect((await request(mini).get('/')).status).toBe(200);
    const third = await request(mini).get('/');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('public orders', () => {
  it('masks phones in the list unless the key may see them', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 12550 });
    await placeOrder(auth.accessToken, workspace.id, variant.id);
    const listWith = (secret) => request(app).get('/api/v1/public/orders').set(bearer(secret));

    // A manager is shown masked phones in the dashboard; a key they mint is no wider.
    const manager = await addMemberWithRole(auth.accessToken, workspace.id, 'workspace_manager', 'Store Manager');
    const managerKey = await mintKey(manager.accessToken, workspace.id, { scopes: ['orders:read'], name: 'Manager key' });
    const masked = await listWith(managerKey.secret);
    expect(masked.status).toBe(200);
    expect(masked.body.orders[0].contact.phone).toMatch(/\*/);
    expect(masked.body.orders[0].contact.phone).not.toBe('01000003333');
    expect(masked.body.orders[0].contact.fullName).toBe('API Buyer');

    // The owner's key without the customers scope is masked too: both must allow it.
    const ordersOnly = await mintKey(auth.accessToken, workspace.id, { scopes: ['orders:read'], name: 'Orders only' });
    expect((await listWith(ordersOnly.secret)).body.orders[0].contact.phone).toMatch(/\*/);

    // The owner's key with customers:read gets the number as stored.
    const withCustomers = await mintKey(auth.accessToken, workspace.id, { scopes: ['orders:read', 'customers:read'], name: 'With customers' });
    const full = await listWith(withCustomers.secret);
    expect(full.body.orders[0].contact.phone).not.toMatch(/\*/);
  });

  it('lists and reads orders in the documented shape — by id and by the number printed on them', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 12550 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, { qty: 2 });
    const { secret } = await mintKey(auth.accessToken, workspace.id, { scopes: ['orders:read'] });

    const list = await request(app).get('/api/v1/public/orders?stage=pending_confirmation').set(bearer(secret));
    expect(list.status).toBe(200);
    expect(list.body.orders.map((o) => o.id)).toEqual([order.id]);
    expect(list.body).toHaveProperty('nextCursor', null);

    const one = await request(app).get(`/api/v1/public/orders/${order.id}`).set(bearer(secret));
    expect(one.status).toBe(200);
    const o = one.body.order;
    expect(o).toMatchObject({
      id: order.id,
      orderNumber: order.orderNumber,
      stage: 'pending_confirmation',
      confirmationState: 'pending',
      financialState: 'pending',
      fulfillmentState: 'unfulfilled',
      paymentMethod: 'cod',
      contact: expect.objectContaining({ fullName: 'API Buyer', phone: expect.any(String) }),
      shippingAddress: expect.objectContaining({ city: 'Cairo' }),
      shipments: [],
    });
    expect(o.amounts.subtotal).toBe(25100); // numbers, not BIGINT strings
    expect(o.items).toEqual([expect.objectContaining({ variantId: variant.id, quantity: 2, unitPrice: 12550 })]);
    // Nothing internal rides along.
    for (const internal of ['riskFlags', 'idempotencyKey', 'paymentTokenHash', 'workspaceId', 'customerId']) {
      expect(o).not.toHaveProperty(internal);
    }

    const byNumber = await request(app).get(`/api/v1/public/orders/by-number/${encodeURIComponent(`#${order.orderNumber}`)}`).set(bearer(secret));
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.order.id).toBe(order.id);
  });

  it("never shows another store's orders", async () => {
    const a = await setupWorkspaceWithProduct();
    const b = await setupWorkspaceWithProduct();
    const orderB = await placeOrder(b.auth.accessToken, b.workspace.id, b.variant.id);
    const { secret } = await mintKey(a.auth.accessToken, a.workspace.id);

    const res = await request(app).get(`/api/v1/public/orders/${orderB.id}`).set(bearer(secret));
    expect(res.status).toBe(404);
    const list = await request(app).get('/api/v1/public/orders').set(bearer(secret));
    expect(list.body.orders).toEqual([]);
  });

  it('records every confirmation outcome the way the queue does, and corrects a final one only with a reason', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 10 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, { qty: 3 });
    const { secret } = await mintKey(auth.accessToken, workspace.id);
    const confirm = (body) =>
      request(app).post(`/api/v1/public/orders/${order.id}/confirmation`).set(bearer(secret)).send(body);

    const unreachable = await confirm({ outcome: 'unreachable', notes: 'No answer' });
    expect(unreachable.status).toBe(200);
    expect(unreachable.body.order.confirmationState).toBe('unreachable');
    expect(unreachable.body.order.stage).toBe('needs_follow_up');
    const task = await db.ConfirmationTask.findOne({ where: { orderId: order.id } });
    expect(task.status).toBe('queued'); // back in the queue, not locked to the key's creator
    expect(task.lockedByUserId).toBeNull();
    expect(task.nextRetryAt).not.toBeNull();

    const confirmed = await confirm({ outcome: 'confirmed' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.order.confirmationState).toBe('confirmed');
    expect(confirmed.body.order.stage).toBe('ready_to_ship');

    const again = await confirm({ outcome: 'confirmed' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('OUTCOME_UNCHANGED');

    const noReason = await confirm({ outcome: 'postponed' });
    expect(noReason.status).toBe(409);
    expect(noReason.body.error.code).toBe('CORRECTION_NOT_ALLOWED');

    // A rejection needs a reason, a correction too.
    const rejectBare = await confirm({ outcome: 'rejected' });
    expect(rejectBare.status).toBe(422);

    const rejected = await confirm({ outcome: 'rejected', reason: 'Customer refused on the second call' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.order.confirmationState).toBe('rejected');
    // The correction released the stock the confirmation kept reserved.
    expect((await db.ProductVariant.findByPk(variant.id)).reservedStock).toBe(0);
  });

  it('refuses confirmation for an order that is not cash on delivery', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct();
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, { paymentMethod: 'bank_transfer' });
    const { secret } = await mintKey(auth.accessToken, workspace.id);
    const res = await request(app)
      .post(`/api/v1/public/orders/${order.id}/confirmation`)
      .set(bearer(secret))
      .send({ outcome: 'confirmed' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_COD');
  });

  it('ships, tracks and delivers an order, then records the COD cash — once, however often it is called', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ price: 20000 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, { qty: 1 });
    const { secret } = await mintKey(auth.accessToken, workspace.id);
    const api = (method, path) => request(app)[method](`/api/v1/public/orders/${order.id}${path}`).set(bearer(secret));

    // Shipping an unconfirmed COD order is refused by the same rule as the dashboard.
    const early = await api('post', '/shipments').send({ carrierCode: 'Sharks Fulfilment', waybillNumber: 'SH-1' });
    expect(early.status).toBeGreaterThanOrEqual(400);

    await api('post', '/confirmation').send({ outcome: 'confirmed' });
    const created = await api('post', '/shipments').send({ carrierCode: 'Sharks Fulfilment', waybillNumber: 'SH-1001' });
    expect(created.status).toBe(201);
    expect(created.body.shipment).toMatchObject({ carrierCode: 'Sharks Fulfilment', waybillNumber: 'SH-1001', status: 'created' });
    const shipmentId = created.body.shipment.id;

    for (const status of ['picked_up', 'in_transit', 'out_for_delivery', 'delivered']) {
      const moved = await api('patch', `/shipments/${shipmentId}`).send({ status });
      expect(moved.status).toBe(200);
      expect(moved.body.shipment.status).toBe(status);
    }

    const delivered = await api('get', '');
    expect(delivered.body.order.stage).toBe('delivered');
    expect(delivered.body.order.fulfillmentState).toBe('fulfilled');
    expect(delivered.body.order.shipments).toHaveLength(1);

    const collected = await api('post', '/cod-collected');
    expect(collected.status).toBe(200);
    expect(collected.body.order.financialState).toBe('paid');
    expect(collected.body.order.amounts.paid).toBe(collected.body.order.amounts.total);

    const twice = await api('post', '/cod-collected');
    expect(twice.status).toBe(200);
    expect(twice.body.order.amounts.paid).toBe(collected.body.order.amounts.total);
    expect(await db.Payment.count({ where: { orderId: order.id, status: 'captured' } })).toBe(1);

    const shipments = await api('get', '/shipments');
    expect(shipments.body.shipments.map((s) => s.status)).toEqual(['delivered']);
  });

  it('cancels an order with a reason, releasing its stock', async () => {
    const { auth, workspace, variant } = await setupWorkspaceWithProduct({ stock: 5 });
    const order = await placeOrder(auth.accessToken, workspace.id, variant.id, { qty: 2 });
    const { secret } = await mintKey(auth.accessToken, workspace.id);

    const res = await request(app)
      .post(`/api/v1/public/orders/${order.id}/cancel`)
      .set(bearer(secret))
      .send({ reason: 'Out of delivery zone' });
    expect(res.status).toBe(200);
    expect(res.body.order.stage).toBe('cancelled');
    expect(res.body.order.cancellationReason).toBe('Out of delivery zone');
    expect((await db.ProductVariant.findByPk(variant.id)).reservedStock).toBe(0);
  });
});
