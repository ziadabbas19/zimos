'use strict';

// Locked orders and outgoing webhooks (ORDERS_LOCK_ENABLED,
// webhooks/orderChangeDetector.js, webhook_order_holds): nothing goes while an
// order is locked; when it opens — a renewal, a top-up, the dashboard's "pay
// the fees" — its events go out on the next pass as if it had just changed:
// order.created when it was never sent, one order.status_changed when it was
// sent before and moved meanwhile, and never anything twice.

const crypto = require('crypto');
const { app, request } = require('../helpers/factories');
const db = require('../../src/db/models');
const wallet = require('../../src/modules/billing/walletService');
const orderService = require('../../src/modules/orders/orderService');
const { runOnce } = require('../../src/modules/webhooks/webhookWorker');
const { RECHECK_MS } = require('../../src/modules/webhooks/orderChangeDetector');
const h = require('../helpers/lockedStores');

h.switchOn();

const { CONTACT } = h;
const api = (store, method, path) => request(app)[method](`/api/v1/workspaces/${store.wid}${path}`).set(h.bearer(store.token));

async function addEndpoint(store) {
  const res = await api(store, 'post', '/webhooks').send({ url: 'http://127.0.0.1:9/hooks', events: ['order.created', 'order.status_changed'] });
  if (res.status !== 201) throw new Error(`addEndpoint failed: ${res.status} ${JSON.stringify(res.body)}`);
}

/** The deliveries queued about one order, oldest first: [eventType, payload]. */
async function sentAbout(store, orderId) {
  const rows = await db.WebhookDelivery.findAll({ where: { workspaceId: store.wid }, order: [['createdAt', 'ASC']] });
  return rows.filter((d) => d.payload && d.payload.data && d.payload.data.order && d.payload.data.order.id === orderId).map((d) => [d.eventType, d.payload]);
}

// Each pass a little later than the last, past the hold's recheck interval.
let clock;
const pass = () => {
  clock += RECHECK_MS + 5000;
  return runOnce({ now: new Date(clock) });
};
beforeEach(() => {
  clock = Date.now() + 1000;
});

describe('a locked order and its webhooks', () => {
  it('a lapsed store: nothing while locked; renewed, order.created goes once, with the details', async () => {
    const store = await h.monthlyStore({ lapsed: true });
    await addEndpoint(store);
    const order = await h.placed(store);

    await pass();
    await pass();
    expect(await sentAbout(store, order.id)).toEqual([]);
    expect(await db.WebhookOrderHold.findByPk(order.id)).not.toBeNull();

    await h.renew(store);
    await pass();
    const sent = await sentAbout(store, order.id);
    expect(sent.map(([type]) => type)).toEqual(['order.created']);
    expect(sent[0][1].data.order.contact).toMatchObject({ fullName: CONTACT.fullName, phone: CONTACT.phone });
    expect(await db.WebhookOrderHold.findByPk(order.id)).toBeNull();

    // Further passes, and a change that moves no state, send nothing more.
    await api(store, 'patch', `/orders/${order.id}/meta`).send({ addTags: ['vip'] });
    await pass();
    await pass();
    expect((await sentAbout(store, order.id)).map(([type]) => type)).toEqual(['order.created']);
  });

  it('sent before, then locked and changed meanwhile: a top-up sends one status change, never a second created', async () => {
    const store = await h.payPerOrderStore({ balance: h.FEE });
    await addEndpoint(store);
    const first = await h.placed(store);
    const second = await h.placed(store);
    await pass();
    expect((await sentAbout(store, second.id)).map(([type]) => type)).toEqual(['order.created']);

    // The balance pays the first order's fee; the second is locked from now on, and cancelled while locked.
    expect((await h.confirm(store, first.id)).status).toBe(200);
    expect((await api(store, 'post', `/orders/${second.id}/cancel`).send({ reason: 'No answer' })).status).toBe(200);
    await pass();
    await pass();
    expect((await sentAbout(store, second.id)).map(([type]) => type)).toEqual(['order.created']);
    expect((await sentAbout(store, first.id)).map(([type]) => type)).toEqual(['order.created', 'order.status_changed']);

    await h.topUp(store, 500);
    await pass();
    const sent = await sentAbout(store, second.id);
    expect(sent.map(([type]) => type)).toEqual(['order.created', 'order.status_changed']);
    expect(sent[1][1].data).toMatchObject({ previous: { stage: 'pending_confirmation' }, current: { stage: 'cancelled' } });
    await pass();
    expect(await sentAbout(store, second.id)).toHaveLength(2);
  });

  it('paid online while short: held, then "pay the fees" opens it and order.created goes', async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    await addEndpoint(store);
    const order = await h.placed(store, { paymentMethod: 'card' });
    const init = await api(store, 'post', `/orders/${order.id}/payments`).send({});
    expect((await api(store, 'post', `/payments/${init.body.payment.id}/capture`).send({})).status).toBe(200);
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('due');
    await pass();
    expect(await sentAbout(store, order.id)).toEqual([]);

    // Money that arrived without a credit the settle hears about (a correction written straight in).
    await db.sequelize.transaction(async (t) => {
      const w = await wallet.lockWallet(store.wid, t);
      await db.WalletLedgerEntry.create(
        { workspaceId: store.wid, entryType: 'adjustment', cashDelta: 300, balanceAfter: 300, currency: 'EGP', idempotencyKey: `adj:${crypto.randomUUID()}` },
        { transaction: t }
      );
      await w.update({ cashBalance: 300 }, { transaction: t });
    });
    await pass();
    expect(await sentAbout(store, order.id)).toEqual([]);

    expect((await api(store, 'post', '/orders/locked/settle').send({})).body).toMatchObject({ settled: 1 });
    await pass();
    expect((await sentAbout(store, order.id)).map(([type]) => type)).toEqual(['order.created']);
    await pass();
    expect(await sentAbout(store, order.id)).toHaveLength(1);
  });

  it('an order that locks between the two reads of a pass is held, not lost: its snapshot stays, it goes once it opens', async () => {
    const store = await h.payPerOrderStore({ balance: 1000 });
    await addEndpoint(store);
    const order = await h.placed(store);

    // The store's last fee spent between the scanner's lock check and its read of the order.
    const real = orderService.getOrder;
    const spy = jest.spyOn(orderService, 'getOrder').mockImplementation(async (...args) => ({ ...(await real(...args)), contactLocked: true }));
    await pass();
    spy.mockRestore();
    expect(await sentAbout(store, order.id)).toEqual([]);
    expect(await db.WebhookOrderHold.findByPk(order.id)).not.toBeNull();
    expect(await db.WebhookOrderState.findOne({ where: { orderId: order.id } })).toBeNull();

    await pass();
    expect((await sentAbout(store, order.id)).map(([type]) => type)).toEqual(['order.created']);
    expect(await db.WebhookOrderHold.findByPk(order.id)).toBeNull();
  });
});
