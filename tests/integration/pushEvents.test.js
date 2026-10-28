'use strict';

// Device notifications for the merchant's notifications (notifications/push/pushDigest.js,
// merchantNotificationService.create): what reaches a device for an order (normal and
// locked), never anything about the customer; the preferences and decision 5's defaults;
// gathering in a window; order.paid (online only), lost orders and WhatsApp; failures
// that never touch the bell or the order; and off = as before.

const crypto = require('crypto');
const webpush = require('web-push');
const { app, request, addMemberWithRole } = require('../helpers/factories');
const { CONTACT, ADDRESS, payPerOrderStore, monthlyStore, placed, switchOn } = require('../helpers/lockedStores');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const queue = require('../../src/core/queue');
const outbox = require('../../src/core/outbox/outbox');
const service = require('../../src/modules/notifications/merchantNotificationService');
const events = require('../../src/modules/notifications/merchantNotificationEvents');
const pushDigest = require('../../src/modules/notifications/push/pushDigest');
const orderStateService = require('../../src/modules/orders/orderStateService');
const orderLock = require('../../src/modules/orders/orderLock');

const loaded = { ...env.push };
const H = (token) => ({ Authorization: `Bearer ${token}` });

let sendSpy;
beforeEach(() => {
  sendSpy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.assign(env.push, loaded);
});

function pushOn() {
  const keys = webpush.generateVAPIDKeys();
  Object.assign(env.push, { enabled: true, vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:ops@zimos.test' });
}

function browser() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}

/** Subscribes a browser of the account behind `token`, in `locale`. */
async function device(token, locale = 'en') {
  const sub = browser();
  const res = await request(app).put('/api/v1/me/push/subscriptions').set(H(token)).send({ app: 'dashboard', subscription: sub, locale });
  expect(res.status).toBe(200);
  return { ...sub, id: res.body.subscription.id };
}

const payloads = () => sendSpy.mock.calls.map(([, payload]) => JSON.parse(payload));
const raw = () => sendSpy.mock.calls.map(([, payload]) => payload).join('\n');
const PRIVATE = [CONTACT.fullName, CONTACT.phone, CONTACT.email, ADDRESS.addressLine, ADDRESS.city, ADDRESS.province, ADDRESS.notes, 'Leave at the door', 'Locked Buyer', '01000007777'];
const setPush = (store, types) =>
  request(app)
    .put(`/api/v1/workspaces/${store.wid}/notifications/preferences`)
    .set(H(store.token))
    .send({ types: Object.entries(types).map(([type, push]) => ({ type, push })) });

/** Holds the push.flush jobs back (under test the queue runs a job at once) and returns them. */
function holdFlushes() {
  const held = [];
  const real = queue.add;
  jest.spyOn(queue, 'add').mockImplementation((name, job, payload, options) => {
    if (job === 'push.flush') {
      held.push({ payload, options });
      return Promise.resolve({ id: null, queued: true });
    }
    return real.call(queue, name, job, payload, options);
  });
  return held;
}

describe('push off: exactly as before', () => {
  it('an order, a paid order and a lost order send nothing and add no new kind of bell row', async () => {
    const store = await monthlyStore();
    const order = await placed(store, { paymentMethod: 'card' });
    await db.sequelize.transaction((t) => orderStateService.setFinancialState(store.wid, order.id, 'paid', null, t));
    await outbox.record(null, 'lost_order.created', { workspaceId: store.wid, checkoutSessionId: crypto.randomUUID() });
    await events.whatsappMessage(store.wid, { conversationId: crypto.randomUUID() });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(await db.PushDigest.count()).toBe(0);
    expect(await db.PushSentKey.count()).toBe(0);
    const types = (await db.MerchantNotification.findAll({ where: { workspaceId: store.wid } })).map((n) => n.type);
    expect(types).toContain('order.new');
    expect(types.filter((type) => ['order.paid', 'lost_order.new', 'whatsapp.message'].includes(type))).toEqual([]);
  });

  it('the settings list the types they always had, without push', async () => {
    const store = await monthlyStore();
    const res = await request(app).get(`/api/v1/workspaces/${store.wid}/notifications/preferences`).set(H(store.token));
    expect(res.body.channels).toEqual(['inApp', 'email', 'whatsapp']);
    expect(res.body.types.some((row) => ['order.paid', 'lost_order.new', 'whatsapp.message'].includes(row.type))).toBe(false);
  });
});

describe('push on: a new order', () => {
  beforeEach(() => pushOn());

  it("reaches the owner's device: the store's name, the order's number and amount, and nothing about the customer", async () => {
    const store = await monthlyStore();
    await device(store.token);
    const order = await placed(store);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [payload] = payloads();
    expect(payload).toMatchObject({ type: 'order.new', title: store.workspace.name, count: 1, url: `/orders/${order.id}?workspace=${store.wid}` });
    expect(payload.body).toContain(order.orderNumber);
    expect(Object.keys(payload).sort()).toEqual(['body', 'count', 'tag', 'title', 'type', 'url', 'v']);
    for (const value of PRIVATE) expect(raw()).not.toContain(value);
    // The bell is as it was: its row still names the customer.
    const bell = await db.MerchantNotification.findOne({ where: { workspaceId: store.wid, type: 'order.new' } });
    expect(bell.body).toContain(CONTACT.fullName);
  });

  describe('a locked order (pay per order, no balance)', () => {
    switchOn();

    it('its number and amount, never its customer: the same as the lock shows', async () => {
      const store = await payPerOrderStore({ balance: 0 });
      await device(store.token, 'ar');
      const order = await placed(store);
      expect(await orderLock.isLocked(await db.Order.findByPk(order.id))).toBe(true);
      // The bell masks the customer of a locked order; the device never had them.
      const bell = await db.MerchantNotification.findOne({ where: { workspaceId: store.wid, type: 'order.new' } });
      expect(bell.body).toContain(orderLock.MASK);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const [payload] = payloads();
      expect(payload.body).toContain(order.orderNumber);
      expect(payload.body).toMatch(/طلب جديد/);
      for (const value of PRIVATE) expect(raw()).not.toContain(value);
    });
  });

  it("follows the teammate's choice: off for new orders, nothing; a teammate without orders access, nothing", async () => {
    const store = await monthlyStore();
    await device(store.token);
    const editor = await addMemberWithRole(store.token, store.wid, 'editor', 'Shop Editor');
    await device(editor.accessToken);
    expect((await setPush(store, { 'order.new': false })).status).toBe(200);
    await placed(store);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: 'order.new' } })).toBe(1);
  });

  it('without a device, or with one the push service dropped (410), the order and its bell row are as always', async () => {
    const store = await monthlyStore();
    const first = await placed(store);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(await db.PushDigest.count()).toBe(0);

    const gone = await device(store.token);
    sendSpy.mockRejectedValue(new webpush.WebPushError('Received unexpected response code', 410, {}, '', gone.endpoint));
    const second = await placed(store);
    expect(await db.PushSubscription.count({ where: { id: gone.id } })).toBe(0);
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: 'order.new' } })).toBe(2);
    expect(first.id).not.toBe(second.id);
  });

  it('a push service that cannot be reached never fails the order', async () => {
    const store = await monthlyStore();
    await device(store.token);
    sendSpy.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    const order = await placed(store);
    expect(order.id).toBeTruthy();
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: 'order.new' } })).toBe(1);
  });
});

describe("push on: decision 5's defaults", () => {
  beforeEach(() => pushOn());

  it('on for new, paid, suspicious orders, WhatsApp and a failed connection; off for the rest; the new types listed', async () => {
    const store = await monthlyStore();
    const res = await request(app).get(`/api/v1/workspaces/${store.wid}/notifications/preferences`).set(H(store.token));
    expect(res.body.channels).toEqual(['inApp', 'email', 'push', 'whatsapp']);
    const push = Object.fromEntries(res.body.types.map((row) => [row.type, row.push]));
    expect(push).toMatchObject({
      'order.new': true,
      'order.paid': true,
      'whatsapp.message': true,
      'order.suspicious': true,
      'integration.failed': true,
      'lost_order.new': false,
      'stock.low': false,
      'export.ready': false,
      'shipping.batch_done': false,
      automation: false,
    });
    expect(res.body.types.find((row) => row.type === 'whatsapp.message')).toMatchObject({ only: ['push'], inApp: false, email: false, whatsapp: false });
  });

  it('a type that is off by default is sent once the teammate turns it on', async () => {
    const store = await monthlyStore();
    await device(store.token);
    await service.create(store.wid, { type: 'export.ready', title: 'Export', link: '/exports', data: {}, dedupeKey: `x:${crypto.randomUUID()}` });
    expect(sendSpy).not.toHaveBeenCalled();
    expect((await setPush(store, { 'export.ready': true })).status).toBe(200);
    await service.create(store.wid, { type: 'export.ready', title: 'Export', link: '/exports', data: {}, dedupeKey: `x:${crypto.randomUUID()}` });
    expect(payloads().map((p) => p.type)).toEqual(['export.ready']);
  });
});

describe('push on: gathered in a window', () => {
  beforeEach(() => pushOn());

  it('five new orders within the window are one device notification: "5 new orders", opening the list', async () => {
    const store = await monthlyStore();
    await device(store.token);
    const held = holdFlushes();
    for (let i = 0; i < 5; i += 1) {
      await service.create(store.wid, { type: 'order.new', title: 'x', data: { orderId: crypto.randomUUID(), customerName: CONTACT.fullName }, dedupeKey: `n:${i}` });
    }
    expect(held).toHaveLength(1);
    expect(held[0].options).toMatchObject({ delayMs: 20000, workspaceId: store.wid });
    const digests = await db.PushDigest.findAll();
    expect(digests).toHaveLength(1);
    expect(digests[0].count).toBe(5);
    expect(Object.keys(digests[0].refs)).toEqual(['orderId']);
    expect(sendSpy).not.toHaveBeenCalled();

    await pushDigest.flush(held[0].payload.digestId);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(payloads()[0]).toMatchObject({ type: 'order.new', body: '5 new orders', count: 5, url: `/orders?workspace=${store.wid}` });
    expect(await db.PushDigest.count()).toBe(0);
    for (const value of PRIVATE) expect(raw()).not.toContain(value);
  });

  it('a window that closed opens the next one; one lost send is caught by the overdue sweep', async () => {
    const store = await monthlyStore();
    await device(store.token);
    const held = holdFlushes();
    await service.create(store.wid, { type: 'order.new', title: 'x', data: { orderId: crypto.randomUUID() }, dedupeKey: 'w1' });
    await pushDigest.flush(held[0].payload.digestId);
    await service.create(store.wid, { type: 'order.new', title: 'x', data: { orderId: crypto.randomUUID() }, dedupeKey: 'w2' });
    expect(held).toHaveLength(2);
    // The second send is lost: the sweep sends it once it is overdue.
    await db.PushDigest.update({ flushAt: new Date(Date.now() - 10 * 60 * 1000) }, { where: {} });
    expect(await pushDigest.flushOverdue()).toEqual({ flushed: 1 });
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('at the send, a teammate who left or turned it off in between gets nothing', async () => {
    const store = await monthlyStore();
    await device(store.token);
    const held = holdFlushes();
    await service.create(store.wid, { type: 'order.new', title: 'x', data: { orderId: crypto.randomUUID() }, dedupeKey: 'left' });
    await setPush(store, { 'order.new': false });
    expect(await pushDigest.flush(held[0].payload.digestId)).toMatchObject({ sent: 0, skipped: 'not_allowed' });
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('push on: the same thing once (decision 6)', () => {
  beforeEach(() => pushOn());

  const day = (offset = 0) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // What merchantNotificationEvents.orderCreated writes for a variant running low (one bell row a variant a day).
  const lowStock = (store, productId, variantId, date = day()) =>
    service.create(store.wid, {
      type: 'stock.low',
      title: 'x',
      link: `/catalog/${productId}`,
      data: { productId, variantId, label: 'M', available: 1 },
      dedupeKey: `stock.low:${variantId}:${date}`,
    });
  const choose = (store, types) =>
    request(app).put(`/api/v1/workspaces/${store.wid}/notifications/preferences`).set(H(store.token)).send({ types });

  it('a product running low reaches a device once a day, with the bell off for it, whichever of its variants and however many orders', async () => {
    const store = await monthlyStore();
    await device(store.token);
    expect((await choose(store, [{ type: 'stock.low', push: true, inApp: false }])).status).toBe(200);
    const held = holdFlushes();
    const [shirt, mug] = [crypto.randomUUID(), crypto.randomUUID()];

    await lowStock(store, shirt, 'shirt-m');
    await lowStock(store, shirt, 'shirt-m'); // the next order with the same size
    await lowStock(store, shirt, 'shirt-l'); // another size of the same product
    await lowStock(store, mug, 'mug-1');
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: 'stock.low' } })).toBe(0);
    const digests = await db.PushDigest.findAll();
    expect(digests.map((d) => d.count)).toEqual([2]);
    await pushDigest.flush(held[0].payload.digestId);
    expect(payloads()).toEqual([expect.objectContaining({ type: 'stock.low', count: 2, body: '2 products are running low' })]);

    // Later the same day: nothing more for either product.
    await lowStock(store, shirt, 'shirt-m');
    await lowStock(store, mug, 'mug-1');
    expect(await db.PushDigest.count()).toBe(0);
    expect(held).toHaveLength(1);

    // The next day, once again.
    await lowStock(store, shirt, 'shirt-m', day(1));
    expect((await db.PushDigest.findAll()).map((d) => d.count)).toEqual([1]);
    expect(held).toHaveLength(2);
  });

  it('with the bell on as well, and for any other type that repeats (a failed connection): once a day', async () => {
    const store = await monthlyStore();
    await device(store.token);
    expect((await choose(store, [{ type: 'integration.failed', inApp: false, push: true }])).status).toBe(200);
    const held = holdFlushes();
    const failed = () => service.create(store.wid, { type: 'integration.failed', title: 'x', data: { integration: 'bosta' }, dedupeKey: `integration.failed:bosta:${day()}` });
    await failed();
    await failed();
    await failed();
    expect((await db.PushDigest.findAll()).map((d) => d.count)).toEqual([1]);

    await pushDigest.flush(held[0].payload.digestId);
    expect((await choose(store, [{ type: 'stock.low', push: true }])).status).toBe(200);
    const shirt = crypto.randomUUID();
    await lowStock(store, shirt, 'shirt-m');
    await lowStock(store, shirt, 'shirt-l');
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: 'stock.low' } })).toBe(2);
    expect((await db.PushDigest.findAll()).map((d) => d.count)).toEqual([1]);
  });

  it('a teammate without a device is not marked: the device subscribed later that day still hears of the product', async () => {
    const store = await monthlyStore();
    expect((await choose(store, [{ type: 'stock.low', push: true }])).status).toBe(200);
    const shirt = crypto.randomUUID();
    await lowStock(store, shirt, 'shirt-m');
    expect(await db.PushSentKey.count()).toBe(0);
    await device(store.token);
    holdFlushes();
    await lowStock(store, shirt, 'shirt-l');
    expect((await db.PushDigest.findAll()).map((d) => d.count)).toEqual([1]);
  });

  it('what was sent is forgotten after 3 days by the daily job', async () => {
    const store = await monthlyStore();
    await device(store.token);
    expect((await choose(store, [{ type: 'stock.low', push: true }])).status).toBe(200);
    holdFlushes();
    await lowStock(store, crypto.randomUUID(), 'old');
    await lowStock(store, crypto.randomUUID(), 'new');
    expect(await db.PushSentKey.count()).toBe(2);
    // One of the two was sent four days ago.
    await db.sequelize.query(
      "UPDATE push_sent_keys SET created_at = now() - interval '4 days' WHERE ctid IN (SELECT ctid FROM push_sent_keys ORDER BY dedupe_key LIMIT 1)"
    );
    expect(await pushDigest.forgetSentKeys()).toEqual({ removed: 1 });
    expect(await db.PushSentKey.count()).toBe(1);
  });
});

describe('push on: the types that came with it', () => {
  beforeEach(() => pushOn());

  it('order.paid: an order paid online is told, in the bell too; cash on delivery is not', async () => {
    const store = await monthlyStore();
    await device(store.token);
    const card = await placed(store, { paymentMethod: 'card' });
    const cod = await placed(store);
    sendSpy.mockClear();
    await db.sequelize.transaction((t) => orderStateService.setFinancialState(store.wid, card.id, 'paid', null, t));
    await db.sequelize.transaction((t) => orderStateService.setFinancialState(store.wid, cod.id, 'paid', null, t));

    const paid = await db.MerchantNotification.findAll({ where: { workspaceId: store.wid, type: 'order.paid' } });
    expect(paid.map((n) => n.link)).toEqual([`/orders/${card.id}`]);
    expect(payloads().map((p) => [p.type, p.url])).toEqual([['order.paid', `/orders/${card.id}?workspace=${store.wid}`]]);
    expect(payloads()[0].body).toContain(card.orderNumber);
    for (const value of PRIVATE) expect(raw()).not.toContain(value);
  });

  it('lost_order.new: in the bell; on a device once turned on (off by default), opening the lost orders', async () => {
    const store = await monthlyStore();
    await device(store.token);
    await outbox.record(null, 'lost_order.created', { workspaceId: store.wid, checkoutSessionId: crypto.randomUUID() });
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: 'lost_order.new' } })).toBe(1);
    expect(sendSpy).not.toHaveBeenCalled();
    await setPush(store, { 'lost_order.new': true });
    await outbox.record(null, 'lost_order.created', { workspaceId: store.wid, checkoutSessionId: crypto.randomUUID() });
    expect(payloads()).toEqual([expect.objectContaining({ type: 'lost_order.new', body: 'A new lost order', url: `/abandoned-carts?workspace=${store.wid}` })]);
  });

  it('whatsapp.message: a device notification only, gathered per conversation, never the message or who sent it', async () => {
    const store = await monthlyStore();
    await device(store.token);
    const held = holdFlushes();
    const first = crypto.randomUUID();
    await events.whatsappMessage(store.wid, { conversationId: first, text: 'Where is my order? 01000007777', name: CONTACT.fullName });
    await events.whatsappMessage(store.wid, { conversationId: first });
    await events.whatsappMessage(store.wid, { conversationId: crypto.randomUUID() });
    expect(held).toHaveLength(2);
    expect(held[0].options.delayMs).toBe(5 * 60 * 1000);
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: 'whatsapp.message' } })).toBe(0);

    for (const job of held) await pushDigest.flush(job.payload.digestId);
    expect(payloads().map((p) => p.body).sort()).toEqual(['2 new WhatsApp messages', 'A new WhatsApp message']);
    expect(payloads().every((p) => p.url === `/inbox?workspace=${store.wid}`)).toBe(true);
    expect(raw()).not.toContain('Where is my order');
    for (const value of PRIVATE) expect(raw()).not.toContain(value);
  });
});
