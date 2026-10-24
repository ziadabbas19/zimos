'use strict';

// PUBLIC_API_ACK_ENABLED: the accepted-orders feed a till pulls with its API
// key, its per-key receipts (api_key_order_acks, migration 716), and the
// till's own status for an order (order_pos_statuses, migration 717) — a
// note that never moves the order's stage. Off, the paths answer as before.
// Every store sees and acknowledges only its own orders.

const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

const saved = env.publicApi.ack;
afterEach(() => {
  env.publicApi.ack = saved;
});

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
let phone = 0;

async function store() {
  const ctx = await setupWorkspaceWithProduct({ stock: 100 });
  ctx.H = bearer(ctx.auth.accessToken);
  ctx.ws = ctx.workspace.id;
  return ctx;
}

async function mint(ctx, scopes = ['orders:read']) {
  const res = await request(app).post(`/api/v1/workspaces/${ctx.ws}/api-keys`).set(ctx.H).send({ name: `Till ${scopes.join(' ')}`, scopes });
  if (res.status !== 201) throw new Error(`mint ${res.status} ${JSON.stringify(res.body)}`);
  return { H: bearer(res.body.secret), id: res.body.apiKey.id };
}

async function placeOrder(ctx) {
  phone += 1;
  const res = await request(app)
    .post(`/api/v1/workspaces/${ctx.ws}/orders`)
    .set(ctx.H)
    .set('Idempotency-Key', `feed-${Date.now()}-${phone}`)
    .send({
      items: [{ variantId: ctx.variant.id, quantity: 1 }],
      contact: { fullName: 'Feed Buyer', phone: `0101${String(1000000 + phone).padStart(7, '0')}` },
      shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 Tahrir Sq' },
      paymentMethod: 'cod',
    });
  if (res.status !== 201) throw new Error(`order ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const feed = (key, query = '') => request(app).get(`/api/v1/public/orders/accepted${query}`).set(key.H);
const ids = (res) => res.body.orders.map((o) => o.id);

describe('accepted orders feed: off', () => {
  it('every new path answers as it did before it existed', async () => {
    const ctx = await store();
    const key = await mint(ctx, ['orders:read', 'orders:pos_status']);
    const order = await placeOrder(ctx);
    // '/orders/accepted' falls to '/orders/:orderId', which refuses a non-id.
    expect((await feed(key)).status).toBe(422);
    expect((await request(app).post('/api/v1/public/orders/ack').set(key.H).send({ orderIds: [order.id] })).status).toBe(404);
    expect((await request(app).post(`/api/v1/public/orders/${order.id}/ack`).set(key.H)).status).toBe(404);
    expect((await request(app).put(`/api/v1/public/orders/${order.id}/pos-status`).set(key.H).send({ status: 'ready' })).status).toBe(404);
    expect(await db.ApiKeyOrderAck.count()).toBe(0);
  });
});

describe('accepted orders feed: on', () => {
  beforeEach(() => {
    env.publicApi.ack = true;
  });

  it('offers accepted orders oldest first until this key acknowledges them; another key keeps its own', async () => {
    const ctx = await store();
    const till = await mint(ctx);
    const kitchen = await mint(ctx);
    const first = await placeOrder(ctx);
    const second = await placeOrder(ctx);
    const pending = await placeOrder(ctx);

    expect(ids(await feed(till))).toEqual([]);
    await confirmCodOrder(ctx.auth.accessToken, ctx.ws, first.id);
    await confirmCodOrder(ctx.auth.accessToken, ctx.ws, second.id);

    const res = await feed(till);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([first.id, second.id]);
    expect(ids(res)).not.toContain(pending.id);
    expect(res.body.orders[0]).toMatchObject({ orderNumber: first.orderNumber, acceptedVia: 'confirmation', confirmationState: 'confirmed' });
    expect(res.body.orders[0].acceptedAt).toBeTruthy();
    // Phones masked as in the orders list: this key has no customers:read.
    expect(res.body.orders[0].contact.phone).not.toBe(first.contactSnapshot ? first.contactSnapshot.phone : 'x');
    expect(res.body.orders[0].contact.phone).toMatch(/\*/);

    const ack = await request(app).post(`/api/v1/public/orders/${first.id}/ack`).set(till.H);
    expect(ack.status).toBe(200);
    expect(ack.body.ack.orderId).toBe(first.id);
    const again = await request(app).post(`/api/v1/public/orders/${first.id}/ack`).set(till.H);
    expect(again.body.ack.ackedAt).toBe(ack.body.ack.ackedAt);

    expect(ids(await feed(till))).toEqual([second.id]);
    expect(ids(await feed(kitchen))).toEqual([first.id, second.id]);
  });

  it('pages with a cursor, refuses a broken one, and looks back at most 30 days', async () => {
    const ctx = await store();
    const till = await mint(ctx);
    const orders = [await placeOrder(ctx), await placeOrder(ctx), await placeOrder(ctx)];
    for (const o of orders) await confirmCodOrder(ctx.auth.accessToken, ctx.ws, o.id);

    const page1 = await feed(till, '?limit=2');
    expect(ids(page1)).toEqual([orders[0].id, orders[1].id]);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await feed(till, `?limit=2&cursor=${page1.body.nextCursor}`);
    expect(ids(page2)).toEqual([orders[2].id]);
    expect(page2.body.nextCursor).toBeNull();

    // An edited cursor is refused before Postgres casts it: 400, never a 500.
    const bad = await feed(till, '?cursor=not-a-cursor');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CURSOR');
    const edit = (at) => Buffer.from(JSON.stringify({ at, id: orders[0].id })).toString('base64url');
    for (const at of ['2026-13-45 99:99:99+00', '2026-02-30 10:00:00+00', '2026-10-24 24:00:00+00', "2026-10-24 10:00:00+00'; --"]) {
      const res = await feed(till, `?cursor=${edit(at)}`);
      expect([at, res.status, res.body.error && res.body.error.code]).toEqual([at, 400, 'INVALID_CURSOR']);
    }
    // The cursor the API itself gave still works after a round trip.
    expect((await feed(till, `?limit=2&cursor=${page1.body.nextCursor}`)).status).toBe(200);
    const tooOld = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
    expect((await feed(till, `?since=${tooOld}`)).status).toBe(422);
  });

  it('a new key does not receive what was accepted before it, unless it asks with since', async () => {
    const ctx = await store();
    const order = await placeOrder(ctx);
    await confirmCodOrder(ctx.auth.accessToken, ctx.ws, order.id);
    await db.Order.update({ confirmedAt: new Date(Date.now() - 60 * 60 * 1000) }, { where: { id: order.id } });
    const till = await mint(ctx);
    expect(ids(await feed(till))).toEqual([]);
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(ids(await feed(till, `?since=${since}`))).toEqual([order.id]);
  });

  it("acknowledges in bulk only the store's own orders; another store's are unknown and nothing is written for them", async () => {
    const a = await store();
    const b = await store();
    const tillA = await mint(a);
    const tillB = await mint(b);
    const mine = await placeOrder(a);
    const theirs = await placeOrder(b);
    await confirmCodOrder(a.auth.accessToken, a.ws, mine.id);
    await confirmCodOrder(b.auth.accessToken, b.ws, theirs.id);

    expect(ids(await feed(tillA))).toEqual([mine.id]);
    expect(ids(await feed(tillB))).toEqual([theirs.id]);

    const bulk = await request(app).post('/api/v1/public/orders/ack').set(tillA.H).send({ orderIds: [mine.id, theirs.id] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.acked.map((r) => r.orderId)).toEqual([mine.id]);
    expect(bulk.body.unknown).toEqual([theirs.id]);
    expect((await request(app).post(`/api/v1/public/orders/${theirs.id}/ack`).set(tillA.H)).status).toBe(404);
    expect(await db.ApiKeyOrderAck.count({ where: { orderId: theirs.id } })).toBe(0);
    // B's own feed is untouched by A's attempt.
    expect(ids(await feed(tillB))).toEqual([theirs.id]);
  });

  it('a key with only orders:pos_status reads its feed, acknowledges and sets the status — and no other order', async () => {
    const ctx = await store();
    const posOnly = await mint(ctx, ['orders:pos_status']);
    const accepted = await placeOrder(ctx);
    const notAccepted = await placeOrder(ctx);
    await confirmCodOrder(ctx.auth.accessToken, ctx.ws, accepted.id);

    expect(ids(await feed(posOnly))).toEqual([accepted.id]);
    expect((await request(app).put(`/api/v1/public/orders/${accepted.id}/pos-status`).set(posOnly.H).send({ status: 'preparing' })).status).toBe(200);
    expect((await request(app).post(`/api/v1/public/orders/${accepted.id}/ack`).set(posOnly.H)).status).toBe(200);

    // Not in its feed, and not even the one it took: every general read is refused.
    for (const path of [
      '/api/v1/public/orders',
      `/api/v1/public/orders/${notAccepted.id}`,
      `/api/v1/public/orders/${accepted.id}`,
      `/api/v1/public/orders/by-number/${notAccepted.orderNumber}`,
      `/api/v1/public/orders/${notAccepted.id}/shipments`,
      `/api/v1/public/orders/${notAccepted.id}/notes`,
    ]) {
      const res = await request(app).get(path).set(posOnly.H);
      expect([path, res.status]).toEqual([path, 403]);
      expect(JSON.stringify(res.body)).not.toContain('Feed Buyer');
    }
    // Nor any write: confirming or cancelling is not a till's note.
    expect((await request(app).post(`/api/v1/public/orders/${notAccepted.id}/confirmation`).set(posOnly.H).send({ outcome: 'confirmed' })).status).toBe(403);
    expect((await request(app).post(`/api/v1/public/orders/${notAccepted.id}/cancel`).set(posOnly.H).send({ reason: 'x' })).status).toBe(403);
    // A key made for something else (orders:create) does not get the feed.
    const creator = await mint(ctx, ['orders:create']);
    expect((await feed(creator)).status).toBe(403);
  });

  it('pos-status: needs its own scope, only on an accepted order of the store, and never moves the stage', async () => {
    const ctx = await store();
    const other = await store();
    const reader = await mint(ctx, ['orders:read', 'orders:write']);
    const till = await mint(ctx, ['orders:read', 'orders:pos_status']);
    const order = await placeOrder(ctx);
    const theirs = await placeOrder(other);
    await confirmCodOrder(other.auth.accessToken, other.ws, theirs.id);
    const put = (key, id, body) => request(app).put(`/api/v1/public/orders/${id}/pos-status`).set(key.H).send(body);

    expect((await put(reader, order.id, { status: 'preparing' })).status).toBe(403);
    const early = await put(till, order.id, { status: 'preparing' });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('ORDER_NOT_ACCEPTED');

    await confirmCodOrder(ctx.auth.accessToken, ctx.ws, order.id);
    const before = await request(app).get(`/api/v1/public/orders/${order.id}`).set(till.H);
    expect((await put(till, order.id, { status: 'cooking' })).status).toBe(422);
    const set = await put(till, order.id, { status: 'preparing', reference: 'T-12' });
    expect(set.status).toBe(200);
    expect(set.body.pos).toMatchObject({ status: 'preparing', reference: 'T-12' });
    const ready = await put(till, order.id, { status: 'ready' });
    expect(ready.body.pos).toMatchObject({ status: 'ready', reference: 'T-12' });

    const after = await request(app).get(`/api/v1/public/orders/${order.id}`).set(till.H);
    expect(after.body.order.stage).toBe(before.body.order.stage);
    expect(after.body.order.confirmationState).toBe('confirmed');
    expect(after.body.order.pos).toMatchObject({ status: 'ready', reference: 'T-12' });
    const audit = await db.AuditLog.findOne({ where: { workspaceId: ctx.ws, action: 'order.pos_status' }, order: [['createdAt', 'DESC']] });
    expect(audit).toBeTruthy();

    expect((await put(till, theirs.id, { status: 'ready' })).status).toBe(404);
    expect(await db.OrderPosStatus.count({ where: { orderId: theirs.id } })).toBe(0);
  });
});
