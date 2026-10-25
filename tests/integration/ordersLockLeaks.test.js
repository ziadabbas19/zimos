'use strict';

// Locked orders (ORDERS_LOCK_ENABLED, orders/orderLock.js): the paths an
// independent review found still showing, or letting the merchant learn, a
// locked order's customer — the blacklist, a transfer's payer, the store's
// activity log, store credit, the customer e-mails, the reports, gift cards,
// the manual order lookup, a stored webhook sent again, the timeline — and
// the writes that would save "••••" over the real details.

const { app, request } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const notify = require('../../src/modules/notifications/notify');
const orderEmails = require('../../src/modules/notifications/orderEmailService');
const giftCards = require('../../src/modules/giftCards/giftCardService');
const { MASK } = require('../../src/modules/orders/orderLock');
const { hiddenPath } = require('../../src/core/utils/refusesHidden');
const h = require('../helpers/lockedStores');

h.switchOn();
afterEach(() => {
  env.storeFeatures.length = 0;
  jest.restoreAllMocks();
});

const { CONTACT } = h;
const api = (store, method, path) => request(app)[method](`/api/v1/workspaces/${store.wid}${path}`).set(h.bearer(store.token));

/** A lapsed store and one shopper order on it: the order locked, its customer hidden. */
async function lockedOrder() {
  const store = await h.monthlyStore({ lapsed: true });
  const res = await h.shopperOrder(store);
  expect(res.status).toBe(201);
  const order = await db.Order.findByPk(res.body.order.id);
  return { store, orderId: order.id, customerId: order.customerId };
}

const expectLocked = (res) => {
  expect(res.status).toBe(402);
  expect(res.body.error.code).toBe('ORDER_LOCKED');
};

describe('the blacklist (C1)', () => {
  it('a hidden customer cannot be blacklisted, and their phone entry shows no number, no customer and is not found by it', async () => {
    const { store, customerId } = await lockedOrder();
    expectLocked(await api(store, 'patch', `/customers/${customerId}/blacklist`).send({ isBlacklisted: true, reason: 'Fake orders' }));

    const added = await api(store, 'post', '/fraud/blocklist').send({ type: 'phone', value: CONTACT.phone, reason: 'Fake orders' });
    expect([200, 201]).toContain(added.status);
    expect(added.body.entry.customerId).toBeNull();

    const list = await api(store, 'get', '/fraud/blocklist');
    const entry = list.body.entries.find((e) => e.id === added.body.entry.id);
    expect(entry).toMatchObject({ value: MASK, customerId: null, contactLocked: true });
    expect(JSON.stringify(entry)).not.toContain('7777');
    expect((await api(store, 'get', `/fraud/blocklist?q=${CONTACT.phone}`)).body.entries).toEqual([]);
    expect((await api(store, 'get', '/fraud/blocklist?q=7777')).body.entries).toEqual([]);

    await h.renew(store);
    const open = (await api(store, 'get', `/fraud/blocklist?q=${CONTACT.phone}`)).body.entries;
    expect(open).toHaveLength(1);
    expect(open[0].customerId).toBe(customerId);
    expect(open[0].value).toContain('7777');
  });
});

describe('a transfer paid by InstaPay (H1)', () => {
  it('GET /manual-payments/orders/:id hides the payer and the screenshot while the order is locked', async () => {
    const { store, orderId } = await lockedOrder();
    await db.OrderManualPayment.create({
      workspaceId: store.wid,
      orderId,
      kind: 'instapay',
      label: 'InstaPay',
      accountNumber: 'shop@instapay',
      status: 'submitted',
      payerNumber: '01055556666',
      submittedAt: new Date(),
    });
    const res = await api(store, 'get', `/manual-payments/orders/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.manualPayment).toMatchObject({ payerNumber: MASK, proofUrl: null, awaitingReview: true });

    await h.renew(store);
    expect((await api(store, 'get', `/manual-payments/orders/${orderId}`)).body.manualPayment.payerNumber).toBe('01055556666');
  });
});

describe("the store's activity log (H2)", () => {
  it("a locked order's rows come masked, and a shopper's row without its IP", async () => {
    const store = await h.monthlyStore();
    const order = await h.placed(store);
    expect((await api(store, 'patch', `/orders/${order.id}`).send({ contact: { ...CONTACT, fullName: 'Renamed Buyer' } })).status).toBe(200);
    await h.shopperOrder(store);
    await h.lapse(store);

    const logs = (await api(store, 'get', '/audit-logs?entityType=Order&limit=100')).body.logs;
    const mine = logs.filter((l) => l.entityId === order.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toMatch(/Locked Buyer|Renamed Buyer|7777|Tahrir/);
    expect(mine.every((l) => l.contactLocked === true)).toBe(true);
    for (const row of logs.filter((l) => !l.actor)) expect(row.ipAddress).toBeNull();

    await h.renew(store);
    const open = (await api(store, 'get', '/audit-logs?entityType=Order&limit=100')).body.logs.filter((l) => l.entityId === order.id);
    expect(JSON.stringify(open)).toContain('Renamed Buyer');
  });

  it('deleting a lost order no longer records its phone', async () => {
    const store = await h.monthlyStore();
    const session = await db.CheckoutSession.create({
      workspaceId: store.wid,
      status: 'abandoned',
      contactFields: { fullName: 'Lost Shopper', phone: '01000008888' },
      phoneNormalized: '201000008888',
      lastActivityAt: new Date(Date.now() - 3 * h.DAY),
    });
    expect((await api(store, 'delete', `/checkout-sessions/${session.id}`)).status).toBe(200);
    const row = await db.AuditLog.findOne({ where: { workspaceId: store.wid, action: 'checkout_session.deleted' } });
    expect(JSON.stringify(row.beforeState)).not.toContain('8888');
  });
});

describe('store credit (H3)', () => {
  it("lists a hidden holder without who they are, and refuses to adjust their credit", async () => {
    env.storeFeatures.push('store_credit');
    const { store, customerId } = await lockedOrder();
    await db.Customer.update({ storeCreditAmount: 500 }, { where: { id: customerId } });

    const holder = (await api(store, 'get', '/store-credit')).body.customers.find((c) => c.customerId === customerId);
    expect(holder).toMatchObject({ fullName: MASK, phone: MASK, balance: '500', contactLocked: true });
    expectLocked(await api(store, 'post', `/store-credit/customers/${customerId}/adjust`).send({ amount: 100, note: 'Sorry' }));
  });
});

describe("the customer's e-mails (H4)", () => {
  it('none for a locked order; sent again once it opens', async () => {
    const { store, orderId } = await lockedOrder();
    const email = jest.spyOn(notify, 'email').mockResolvedValue({ status: 'sent' });

    expect(await orderEmails.handleEvent(store.wid, 'order.created', { orderId, notifyCustomer: true })).toEqual([]);
    expect(email).not.toHaveBeenCalled();

    await h.renew(store);
    const sent = await orderEmails.handleEvent(store.wid, 'order.created', { orderId, notifyCustomer: true });
    expect(sent.length).toBeGreaterThan(0);
    expect(email).toHaveBeenCalled();
  });
});

describe('the reports and the other lists (M1, M3, M4, M5)', () => {
  it("the customers report names no hidden customer", async () => {
    const { store, customerId } = await lockedOrder();
    const res = await api(store, 'get', '/analytics/reports/customers');
    expect(res.status).toBe(200);
    const top = (res.body.report || res.body).topCustomers || [];
    for (const row of top.filter((r) => r.customerId === customerId)) expect(row.name).toBe(MASK);
    expect(JSON.stringify(top)).not.toContain(CONTACT.fullName);
  });

  it("a gift card bought on a locked order: no recipient shown or searchable, none changed or sent again", async () => {
    env.storeFeatures.push('gift_cards');
    const { store, orderId } = await lockedOrder();
    const { giftCard } = await giftCards.issue(
      store.wid,
      { amount: 1000, currency: 'EGP', recipientName: CONTACT.fullName, recipientEmail: CONTACT.email, sendEmail: false },
      { source: 'order', orderId }
    );
    const id = giftCard ? giftCard.id : (await db.GiftCard.findOne({ where: { orderId } })).id;

    const listed = (await api(store, 'get', '/gift-cards')).body.giftCards.find((c) => c.id === id);
    expect(listed).toMatchObject({ recipientName: MASK, recipientEmail: MASK, contactLocked: true });
    expect((await api(store, 'get', '/gift-cards?q=buyer@example')).body.giftCards).toEqual([]);
    expectLocked(await api(store, 'patch', `/gift-cards/${id}`).send({ recipientName: 'Someone else' }));

    await h.renew(store);
    expect((await api(store, 'get', '/gift-cards?q=buyer@example')).body.giftCards.map((c) => c.recipientEmail)).toEqual([CONTACT.email]);
  });

  it('the manual order lookup and a new contact do not tie a typed phone to a hidden customer', async () => {
    const { store } = await lockedOrder();
    const lookup = (await api(store, 'get', `/orders/manual/customer?phone=${CONTACT.phone}`)).body.customer;
    expect(lookup).toMatchObject({ contactLocked: true, fullName: MASK, totalOrders: null, totalRejectedOrders: null, lastOrder: null });

    const taken = await api(store, 'post', '/contacts').send({ phone: CONTACT.phone });
    expect(taken.status).toBe(409);
    expect(taken.body.error.details.customerId).toBeNull();
  });
});

describe('a stored webhook sent again (L4)', () => {
  it('is refused while its order is locked', async () => {
    const { store, orderId } = await lockedOrder();
    const endpoint = await api(store, 'post', '/webhooks').send({ url: 'http://127.0.0.1:9/hooks', events: ['order.created'] });
    expect(endpoint.status).toBe(201);
    const delivery = await db.WebhookDelivery.create({
      workspaceId: store.wid,
      endpointId: endpoint.body.endpoint ? endpoint.body.endpoint.id : endpoint.body.id,
      eventId: `order.created:${orderId}`,
      eventType: 'order.created',
      payload: { id: `order.created:${orderId}`, type: 'order.created', data: { order: { id: orderId, contact: CONTACT } } },
      status: 'delivered',
      attemptCount: 1,
      nextAttemptAt: new Date(),
    });
    expectLocked(await api(store, 'post', `/webhooks/deliveries/${delivery.id}/resend`));
  });
});

describe('the order timeline (L5)', () => {
  it("hides what was written to the customer while the order is locked", async () => {
    env.storeFeatures.push('order_messages');
    const { store, orderId } = await lockedOrder();
    await db.NotificationLog.create({
      workspaceId: store.wid,
      orderId,
      channel: 'email',
      provider: 'console',
      recipient: CONTACT.email,
      template: 'order_email',
      status: 'sent',
      subject: `Thank you, ${CONTACT.fullName}`,
    });
    const events = (await api(store, 'get', `/orders/${orderId}/timeline`)).body.events;
    const message = events.find((e) => e.type === 'message' && e.data.channel === 'email');
    expect(message.data.subject).toBe(MASK);

    await h.renew(store);
    const open = (await api(store, 'get', `/orders/${orderId}/timeline`)).body.events.find((e) => e.type === 'message');
    expect(open.data.subject).toContain(CONTACT.fullName);
  });
});

describe('writes that would save "••••" (FE-H2..H4) and the shipment draft (FE-H3)', () => {
  it('hiddenPath finds the placeholder at any depth', () => {
    expect(hiddenPath({ contact: { fullName: 'Ali' }, address: { city: 'Cairo', addressLine: `${MASK}` } })).toBe('address.addressLine');
    expect(hiddenPath({ names: ['Giza', MASK] })).toBe('names.1');
    expect(hiddenPath({ contact: { fullName: 'Ali' }, n: 3, ok: true })).toBeNull();
  });

  it('refuses "••••" in an order, its edit and a customer edit — even on a store that locks nothing', async () => {
    const store = await h.monthlyStore();
    const order = await h.placed(store);
    const typed = await h.staffOrder(store, { contact: { ...CONTACT, fullName: MASK } });
    expect(typed.status).toBe(422);
    expect(JSON.stringify(typed.body)).toContain('contact.fullName');
    expect((await api(store, 'patch', `/orders/${order.id}`).send({ notes: MASK })).status).toBe(422);
    const customerId = (await db.Order.findByPk(order.id)).customerId;
    expect((await api(store, 'patch', `/customers/${customerId}`).send({ fullName: `Ali ${MASK}` })).status).toBe(422);
    expect((await api(store, 'post', '/contacts').send({ phone: '01000009999', fullName: MASK })).status).toBe(422);
    // The details as they were.
    expect((await h.getOrder(store, order.id)).contactSnapshot.fullName).toBe(CONTACT.fullName);
  });

  it('the shipment draft of a locked order is refused', async () => {
    const { store, orderId } = await lockedOrder();
    expectLocked(await api(store, 'put', `/orders/${orderId}/shipment-draft`).send({ carrierCode: 'manual', notes: 'Fragile' }));
  });
});
