'use strict';

// Locked orders (ORDERS_LOCK_ENABLED, orders/orderLock.js): the rule in every
// standing a store can be in, the order always stored in full, everything
// opening at once on a renewal or a top-up, store isolation — and each path
// that shows, exports or sends a customer's details, by name, keeping to it.
// The platform console sees everything.

const crypto = require('crypto');
const { app, request, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const orderLock = require('../../src/modules/orders/orderLock');
const h = require('../helpers/lockedStores');

h.switchOn();

const { MASK } = orderLock;
const { CONTACT } = h;
const api = (store, method, path) => request(app)[method](`/api/v1/workspaces/${store.wid}${path}`).set(h.bearer(store.token));

function expectHidden(order) {
  expect(order.contactLocked).toBe(true);
  expect(order.contactSnapshot).toMatchObject({ fullName: MASK, phone: MASK, email: MASK });
  expect(order.shippingAddressSnapshot).toMatchObject({ country: 'EG', province: 'Giza', city: MASK, addressLine: MASK, notes: MASK });
  expect(order.notes).toBe(MASK);
  // What always shows: the products, the prices, the total, the dates, the state.
  expect(order.items).toHaveLength(1);
  expect(Number(order.totalAmount)).toBeGreaterThan(0);
  expect(order.createdAt).toBeTruthy();
  expect(order.confirmationState).toBeTruthy();
}

function expectShown(order) {
  expect(order.contactLocked).toBe(false);
  expect(order.contactSnapshot).toMatchObject({ fullName: CONTACT.fullName, phone: CONTACT.phone });
  expect(order.shippingAddressSnapshot.city).toBe(h.ADDRESS.city);
}

describe('the rule, store by store', () => {
  it('a running monthly plan shows everything', async () => {
    const store = await h.monthlyStore();
    const order = await h.placed(store);
    expectShown(await h.getOrder(store, order.id));
  });

  it('a lapsed monthly plan: the store still sells, the new order is stored in full but shown hidden, and renewing opens it at once', async () => {
    const store = await h.monthlyStore({ lapsed: true });
    const res = await h.shopperOrder(store);
    expect(res.status).toBe(201);
    const { id } = res.body.order;

    const row = await db.Order.findByPk(id);
    expect(row.contactSnapshot).toMatchObject({ fullName: CONTACT.fullName, phone: CONTACT.phone });
    expect(row.shippingAddressSnapshot).toMatchObject(h.ADDRESS);
    expectHidden({ ...(await h.getOrder(store, id)), notes: MASK });

    const refused = await h.confirm(store, id);
    expect(refused.status).toBe(402);
    expect(refused.body.error).toMatchObject({ code: 'ORDER_LOCKED', details: { reason: 'subscription' } });

    await h.renew(store);
    expectShown(await h.getOrder(store, id));
  });

  it('an order confirmed while the plan ran stays visible after it lapses', async () => {
    const store = await h.monthlyStore();
    const order = await h.placed(store);
    expect((await h.confirm(store, order.id)).status).toBe(200);
    await h.lapse(store);
    expectShown(await h.getOrder(store, order.id));
  });

  it('an order confirmed before the column existed (contact_lock null) stays visible on a lapsed store', async () => {
    const store = await h.monthlyStore();
    const order = await h.placed(store);
    expect((await h.confirm(store, order.id)).status).toBe(200);
    await db.Order.update({ contactLock: null }, { where: { id: order.id } });
    await h.lapse(store);
    expectShown(await h.getOrder(store, order.id));
  });

  it('pay per order: a pending order shows while the balance can pay its fee, hides when it cannot, and a top-up opens it', async () => {
    const store = await h.payPerOrderStore({ balance: h.FEE });
    const first = await h.placed(store);
    const second = await h.placed(store);
    expectShown(await h.getOrder(store, second.id));

    expect((await h.confirm(store, first.id)).status).toBe(200);
    expect(await h.balanceOf(store)).toBe(0);
    expectHidden(await h.getOrder(store, second.id));
    expectShown(await h.getOrder(store, first.id));

    await h.topUp(store, 10000);
    expectShown(await h.getOrder(store, second.id));
  });

  it('pay per order: an order cancelled before it was confirmed reads like a pending one — shown while the balance can pay, hidden when it cannot, open again on a top-up', async () => {
    const store = await h.payPerOrderStore({ balance: h.FEE });
    const cancelled = await h.placed(store);
    const other = await h.placed(store);
    expect((await api(store, 'post', `/orders/${cancelled.id}/cancel`).send({ reason: 'Duplicate' })).status).toBe(200);
    expectShown(await h.getOrder(store, cancelled.id));

    // The balance pays the other order's fee: the cancelled one hides with the pending ones.
    expect((await h.confirm(store, other.id)).status).toBe(200);
    expect(await h.balanceOf(store)).toBe(0);
    expect((await h.getOrder(store, cancelled.id)).contactLocked).toBe(true);

    await h.topUp(store, 500);
    expectShown(await h.getOrder(store, cancelled.id));
  });

  it('pay per order with free orders left and no balance shows its pending orders', async () => {
    const store = await h.payPerOrderStore({ balance: 0, freeOrders: 10 });
    const order = await h.placed(store);
    expectShown(await h.getOrder(store, order.id));
  });

  it("is per store: one store's lock is not another's, and nobody reads another store's order", async () => {
    const locked = await h.payPerOrderStore({ balance: 0 });
    const open = await h.monthlyStore();
    const a = await h.placed(locked);
    const b = await h.placed(open);
    expectHidden(await h.getOrder(locked, a.id));
    expectShown(await h.getOrder(open, b.id));
    expect((await api(open, 'get', `/orders/${a.id}`)).status).toBe(404);
    const list = await api(open, 'get', '/orders');
    expect(list.body.orders.map((o) => o.id)).toEqual([b.id]);
  });

  it('a funnel add-on placed as its own order is locked exactly when the order it follows is', async () => {
    const store = await h.monthlyStore();
    const parent = await h.placed(store);
    expect((await h.confirm(store, parent.id)).status).toBe(200);
    const addOn = await h.placed(store);
    await db.Order.update({ source: 'upsell', linkedFromOrderId: parent.id }, { where: { id: addOn.id } });
    const pendingParent = await h.placed(store);
    const lockedAddOn = await h.placed(store);
    await db.Order.update({ source: 'upsell', linkedFromOrderId: pendingParent.id }, { where: { id: lockedAddOn.id } });
    await h.lapse(store);

    expectShown(await h.getOrder(store, addOn.id));
    expect((await h.getOrder(store, lockedAddOn.id)).contactLocked).toBe(true);
  });

  it('the dashboard is told: GET /access (store still open) and GET /orders/locked-summary', async () => {
    const store = await h.monthlyStore({ lapsed: true });
    const a = await h.placed(store);
    const b = await h.placed(store);
    const access = (await api(store, 'get', '/access')).body.access;
    expect(access).toMatchObject({ restricted: true, storefrontClosed: false, ordersLock: true });
    const summary = (await api(store, 'get', '/orders/locked-summary')).body.locked;
    expect(summary).toMatchObject({ enabled: true, mode: 'lapsed', reason: 'subscription', count: 2, due: 0 });
    expect(summary.totals).toEqual([{ currency: 'EGP', count: 2, amount: Number(a.totalAmount) + Number(b.totalAmount) }]);
  });

  it('with the switch off, a lapsed store closes as before and nothing is hidden', async () => {
    env.ordersLock.enabled = false;
    const store = await h.monthlyStore({ lapsed: true });
    expect((await h.shopperOrder(store)).status).toBe(423);
    const order = await h.placed(store);
    const shown = await h.getOrder(store, order.id);
    expect(shown).not.toHaveProperty('contactLocked');
    expect(shown.contactSnapshot.phone).toBe(CONTACT.phone);
  });
});

describe('every path that shows, exports or sends the details keeps to it', () => {
  let store;
  let locked;
  let visible;
  beforeEach(async () => {
    store = await h.monthlyStore();
    visible = await h.placed(store, { contact: { fullName: 'Shown Buyer', phone: '01000008888' } });
    expect((await h.confirm(store, visible.id)).status).toBe(200);
    await h.lapse(store);
    locked = await h.placed(store);
  });

  it('orders list, and the search never matches a locked order by its customer', async () => {
    const list = (await api(store, 'get', '/orders')).body.orders;
    expectHidden(list.find((o) => o.id === locked.id));
    expect(list.find((o) => o.id === visible.id).contactLocked).toBe(false);

    const byPhone = (await api(store, 'get', `/orders?q=${CONTACT.phone}`)).body.orders;
    expect(byPhone).toEqual([]);
    const byName = (await api(store, 'get', `/orders?q=${encodeURIComponent('Locked Buyer')}`)).body.orders;
    expect(byName).toEqual([]);
    const byNumber = (await api(store, 'get', `/orders?q=${encodeURIComponent(locked.orderNumber)}`)).body.orders;
    expect(byNumber.map((o) => o.id)).toEqual([locked.id]);
    expect((await api(store, 'get', `/orders/pipeline?q=${CONTACT.phone}`)).body.total).toBe(0);
  });

  it('order detail and the answers of order actions (items edit, cancel)', async () => {
    expectHidden(await h.getOrder(store, locked.id));
    const edit = await api(store, 'put', `/orders/${locked.id}/items`).send({ items: [{ variantId: store.variant.id, quantity: 2 }] });
    expect(edit.status).toBe(200);
    expect(edit.body.order.contactSnapshot.phone).toBe(MASK);
    const cancel = await api(store, 'post', `/orders/${locked.id}/cancel`).send({ reason: 'No answer' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.order.contactSnapshot.phone).toBe(MASK);
  });

  it('editing the customer on a locked order is refused (PATCH /orders/:id)', async () => {
    const res = await api(store, 'patch', `/orders/${locked.id}`).send({ notes: 'call later' });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('ORDER_LOCKED');
  });

  it('the confirmation queue', async () => {
    const res = await api(store, 'get', '/confirmation-tasks?status=pending');
    expect(res.status).toBe(200);
    const task = res.body.tasks.find((t) => t.order.id === locked.id);
    expect(task.order.contactLocked).toBe(true);
    expect(task.order.contactSnapshot.phone).toBe(MASK);
  });

  it('the CSV export writes •••• and never the details', async () => {
    const res = await api(store, 'get', '/orders/export');
    expect(res.status).toBe(200);
    expect(res.text).toContain(MASK);
    expect(res.text).not.toContain(CONTACT.phone.slice(-7));
    expect(res.text).not.toContain('Locked Buyer');
    expect(res.text).toContain('Shown Buyer');
  });

  it('the public API returns it hidden, marked contactLocked', async () => {
    const out = await require('../../src/modules/publicApi/publicOrderService').getOrder(store.wid, locked.id);
    expect(out).toMatchObject({ contactLocked: true, contact: { phone: MASK, fullName: MASK }, notes: MASK });
    expect(out.shippingAddress).toMatchObject({ province: 'Giza', city: MASK });
  });

  it('webhooks: nothing is queued for a locked order (events and the change scanner); a visible order still goes', async () => {
    const hook = await api(store, 'post', '/webhooks').send({ url: 'http://127.0.0.1:9/hooks', events: ['order.cancelled', 'order.created', 'order.status_changed'] });
    expect(hook.status).toBe(201);
    const fanout = require('../../src/modules/webhooks/webhookFanout');
    const event = (orderId) => ({ id: crypto.randomUUID(), type: 'order.cancelled', workspaceId: store.wid, payload: { orderId }, occurredAt: new Date() });
    expect(await fanout.handleDomainEvent(event(locked.id))).toBe(0);
    expect(await fanout.handleDomainEvent(event(visible.id))).toBe(1);
    expect((await fanout.resendOrders(store.wid, [locked.id])).locked).toEqual([locked.id]);

    await require('../../src/modules/webhooks/webhookWorker').runOnce();
    const deliveries = await db.WebhookDelivery.findAll({ where: { workspaceId: store.wid } });
    expect(deliveries.some((d) => JSON.stringify(d.payload).includes(locked.id))).toBe(false);
    expect(deliveries.some((d) => JSON.stringify(d.payload).includes(CONTACT.phone))).toBe(false);
  });

  it('the dashboard search (Ctrl K): not found by phone or name; found by number with the name hidden', async () => {
    const byPhone = (await api(store, 'get', `/search?q=${CONTACT.phone}`)).body;
    expect(byPhone.orders).toEqual([]);
    expect(byPhone.customers).toEqual([]);
    const byNumber = (await api(store, 'get', `/search?q=${encodeURIComponent(locked.orderNumber)}`)).body;
    expect(byNumber.orders).toEqual([expect.objectContaining({ id: locked.id, customerName: MASK, contactLocked: true })]);
  });

  it('customers: list and detail hidden for a customer known only from locked orders, and not edited', async () => {
    const list = (await api(store, 'get', '/customers')).body.customers;
    const hidden = list.find((c) => c.contactLocked);
    expect(hidden).toMatchObject({ fullName: MASK, phoneNormalized: MASK, email: MASK });
    expect(list.find((c) => !c.contactLocked).fullName).toBe('Shown Buyer');
    const detail = (await api(store, 'get', `/customers/${hidden.id}`)).body.customer;
    expect(detail).toMatchObject({ contactLocked: true, fullName: MASK });
    expect((await api(store, 'patch', `/customers/${hidden.id}`).send({ fullName: 'X' })).status).toBe(402);
  });

  it('contacts list', async () => {
    const contacts = (await api(store, 'get', '/contacts')).body.contacts;
    expect(contacts.find((c) => c.contactLocked)).toMatchObject({ fullName: MASK, phoneRaw: MASK });
    expect((await api(store, 'get', `/contacts?q=${CONTACT.phone}`)).body.contacts).toEqual([]);
  });

  it('the manual order form does not fill a locked customer in', async () => {
    const res = await api(store, 'get', `/orders/manual/customer?phone=${CONTACT.phone}`);
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ contactLocked: true, fullName: MASK, email: MASK });
    expect(res.body.customer.lastAddress).toMatchObject({ province: 'Giza', city: MASK });
  });

  it('lost orders: hidden, the phone not revealed, no WhatsApp', async () => {
    const session = await db.CheckoutSession.create({
      workspaceId: store.wid,
      status: 'abandoned',
      contactFields: { fullName: 'Lost Shopper', phone: '01000009999' },
      phoneNormalized: '201000009999',
      lastActivityAt: new Date(Date.now() - 3 * h.DAY),
    });
    const res = await api(store, 'get', '/checkout-sessions?view=all');
    expect(res.status).toBe(200);
    expect(res.body.sessions.find((s) => s.id === session.id)).toMatchObject({ contactLocked: true, customerName: MASK, phone: MASK, recoveryPath: null });
    expect((await api(store, 'post', `/checkout-sessions/${session.id}/reveal-phone`).send({})).status).toBe(402);
    expect((await api(store, 'post', `/checkout-sessions/${session.id}/whatsapp`).send({})).status).toBe(402);
  });

  it('invoices list, and the invoice PDF bills ••••', async () => {
    const res = await api(store, 'get', '/invoices');
    expect(res.status).toBe(200);
    const mine = res.body.invoices.find((i) => i.order && i.order.id === locked.id);
    expect(mine.order).toMatchObject({ customerName: MASK, contactLocked: true });
    const { shownForInvoice } = require('../../src/modules/orders/orderInvoicePdf');
    const [shown] = await shownForInvoice(store.wid, [await db.Order.findByPk(locked.id, { include: [{ model: db.OrderItem, as: 'items' }] })]);
    expect(shown.contactSnapshot.fullName).toBe(MASK);
    expect(shown.shippingAddressSnapshot.addressLine).toBe(MASK);
  });

  it('fraud: the flagged orders list hides the customer and the IP; block-and-cancel is refused', async () => {
    await db.Order.update({ riskFlags: ['duplicate_order'], ipAddress: '203.0.113.7' }, { where: { id: locked.id } });
    const res = await api(store, 'get', '/fraud/flagged-orders');
    expect(res.status).toBe(200);
    expect(res.body.orders.find((o) => o.id === locked.id)).toMatchObject({ customerName: MASK, phone: MASK, ipAddress: MASK, contactLocked: true });
    expect((await api(store, 'post', `/fraud/flagged-orders/${locked.id}/block`).send({})).status).toBe(402);
  });

  it("the team's new-order notification does not name the customer", async () => {
    await db.MerchantNotification.destroy({ where: { workspaceId: store.wid } });
    await require('../../src/modules/notifications/merchantNotificationEvents').orderCreated(store.wid, locked.id);
    const note = await db.MerchantNotification.findOne({ where: { workspaceId: store.wid, type: 'order.new' } });
    expect(note.body).toContain(MASK);
    expect(note.body).not.toContain('Locked Buyer');
  });

  it('no courier booking, no shipment, no waybill', async () => {
    await expect(require('../../src/modules/shipping/carrierShipmentService').createCarrierShipment(store.wid, locked.id, { carrierCode: 'bosta' }, null)).rejects.toMatchObject({
      code: 'ORDER_LOCKED',
    });
    expect((await api(store, 'post', `/orders/${locked.id}/shipments`).send({ carrierCode: 'manual' })).status).toBe(402);
    expect((await api(store, 'get', `/orders/${locked.id}/waybill`)).status).toBe(402);
  });

  it('no message to the customer: Confirm via WhatsApp is refused and automations skip their messages without trying', async () => {
    expect((await api(store, 'post', `/orders/${locked.id}/whatsapp-confirm`).send({})).status).toBe(402);

    await db.AutomationRule.create({
      workspaceId: store.wid,
      name: 'Thank you',
      trigger: 'order.created',
      actions: [{ type: 'sms', body: 'Thanks {{customer_name}}' }, { type: 'whatsapp_template', template: 'order_confirmation' }, { type: 'add_tag', tag: 'auto' }],
      isActive: true,
    });
    await require('../../src/modules/automations/automationExecutor').trigger(store.wid, 'order.created', { orderId: locked.id });
    const runs = await db.AutomationRun.findAll({ where: { workspaceId: store.wid, orderId: locked.id }, order: [['createdAt', 'ASC']] });
    expect(runs.filter((r) => ['sms', 'whatsapp_template'].includes(r.stepType)).map((r) => r.status)).toEqual(['skipped', 'skipped']);
    expect(runs.find((r) => r.stepType === 'sms').detail).toMatch(/locked/);
    expect(await db.NotificationLog.count({ where: { workspaceId: store.wid, orderId: locked.id } })).toBe(0);
  });

  it('the platform console still sees the customer in full (risk signals across stores)', async () => {
    const other = await h.monthlyStore({ lapsed: true });
    await h.placed(other);
    const admin = await makePlatformUser('admin');
    const res = await request(app).get('/api/v1/admin/risk/signals?type=phone&minWorkspaces=2').set(admin.H);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).toContain(CONTACT.phone);
    expect(text).not.toContain(MASK);
  });
});
