'use strict';

// The pay-per-order fee taken once, when an order is confirmed
// (ORDERS_LOCK_ENABLED, billing/confirmFeeService.js, migration 718): free
// orders first, never below a zero balance, once per order under parallel
// confirmations, refused (the order stays pending and locked) when it cannot
// be paid — from every path that confirms — and never given back.

const crypto = require('crypto');
const { app, request, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');
const confirmFee = require('../../src/modules/billing/confirmFeeService');
const orderLock = require('../../src/modules/orders/orderLock');
const ledgerCheck = require('../../scripts/check-wallet-ledger');
const h = require('../helpers/lockedStores');

h.switchOn();

const { FEE } = h;

/** Polls `check` (an after-commit job) for up to 5 s. */
async function eventually(check) {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function expectLedgerMatches() {
  for (const row of await ledgerCheck.check()) expect(ledgerCheck.problemsOf(row)).toEqual([]);
}

describe('the fee moves from placing the order to confirming it', () => {
  it('placing takes nothing; confirming takes the fee once and leaves the order unlocked', async () => {
    const store = await h.payPerOrderStore({ balance: 1000 });
    const order = await h.placed(store);
    expect(await h.feeEntries(order.id)).toHaveLength(0);
    expect(await h.balanceOf(store)).toBe(1000);

    const res = await h.confirm(store, order.id);
    expect(res.status).toBe(200);
    const entries = await h.feeEntries(order.id);
    expect(entries.map((e) => [e.entryType, Number(e.cashDelta), e.freeOrdersDelta, e.idempotencyKey])).toEqual([
      ['order_confirm_fee', -FEE, 0, `order_confirm_fee:${order.id}`],
    ]);
    expect(await h.balanceOf(store)).toBe(1000 - FEE);
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('unlocked');
    await expectLedgerMatches();
  });

  it('a shopper still orders with an empty balance: no 423, no 402', async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    const res = await h.shopperOrder(store);
    expect(res.status).toBe(201);
    expect(await db.WalletLedgerEntry.count({ where: { workspaceId: store.wid } })).toBe(0);
  });

  it('free orders go first, without touching the balance', async () => {
    const store = await h.payPerOrderStore({ balance: 1000, freeOrders: 2 });
    const orders = [await h.placed(store), await h.placed(store), await h.placed(store)];
    for (const o of orders) expect((await h.confirm(store, o.id)).status).toBe(200);
    const rows = await db.WalletLedgerEntry.findAll({ where: { workspaceId: store.wid, entryType: 'order_confirm_fee' }, order: [['createdAt', 'ASC']] });
    expect(rows.map((e) => [Number(e.cashDelta), e.freeOrdersDelta])).toEqual([
      [0, -1],
      [0, -1],
      [-FEE, 0],
    ]);
    expect(await h.balanceOf(store)).toBe(1000 - FEE);
    await expectLedgerMatches();
  });
});

describe('once, and never below zero', () => {
  it('five parallel confirmations of one order charge it once', async () => {
    const store = await h.payPerOrderStore({ balance: 1000 });
    const order = await h.placed(store);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => h.confirm(store, order.id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await h.feeEntries(order.id)).toHaveLength(1);
    expect(await h.balanceOf(store)).toBe(1000 - FEE);
  });

  it('the database refuses a second confirmation fee for an order, whatever the key', async () => {
    const store = await h.payPerOrderStore({ balance: 1000 });
    const order = await h.placed(store);
    expect((await h.confirm(store, order.id)).status).toBe(200);
    const second = db.sequelize.transaction(async (t) => {
      const row = await wallet.lockWallet(store.wid, t);
      return wallet.writeEntry(row, { type: 'order_confirm_fee', delta: -FEE, orderId: order.id, key: `another:${crypto.randomUUID()}` }, t);
    });
    await expect(second).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
    expect(await h.feeEntries(order.id)).toHaveLength(1);
  });

  it('three orders confirmed at once on a balance for one: one confirms, two are refused, the balance stays >= 0', async () => {
    const store = await h.payPerOrderStore({ balance: FEE + 25 });
    const orders = [await h.placed(store), await h.placed(store), await h.placed(store)];
    const results = await Promise.all(orders.map((o) => h.confirm(store, o.id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 402, 402]);
    for (const r of results.filter((x) => x.status === 402)) {
      expect(r.body.error).toMatchObject({ code: 'ORDER_LOCKED', details: expect.objectContaining({ reason: 'balance', fee: FEE }) });
    }
    expect(await h.balanceOf(store)).toBe(25);
    const refused = orders.filter((o, i) => results[i].status === 402);
    for (const o of refused) {
      const row = await db.Order.findByPk(o.id);
      expect(row.confirmationState).toBe('pending');
      expect(row.contactLock).toBeNull();
    }
    await expectLedgerMatches();
  });

  it('a balance below zero from before (the old overdraft) confirms nothing until topped up', async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    await db.sequelize.transaction(async (t) => {
      const row = await wallet.lockWallet(store.wid, t);
      await wallet.writeEntry(row, { type: 'adjustment', delta: -500, key: `adj:${crypto.randomUUID()}` }, t);
    });
    const order = await h.placed(store);
    expect((await h.confirm(store, order.id)).status).toBe(402);
    await h.topUp(store, 500 + FEE);
    expect((await h.confirm(store, order.id)).status).toBe(200);
    expect(await h.balanceOf(store)).toBe(0);
  });
});

describe('every path that confirms takes the same fee', () => {
  it('the bulk action confirms what the balance covers and names the rest', async () => {
    const store = await h.payPerOrderStore({ balance: 2 * FEE });
    const orders = [await h.placed(store), await h.placed(store), await h.placed(store)];
    const res = await request(app)
      .post(`/api/v1/workspaces/${store.wid}/orders/bulk`)
      .set(h.bearer(store.token))
      .send({ action: 'set_status', orderIds: orders.map((o) => o.id), payload: { status: 'ready_to_ship' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    const failed = res.body.results.find((r) => !r.ok);
    expect(failed).toMatchObject({ orderId: orders[2].id, code: 'ORDER_LOCKED' });
    expect(failed.message).toMatch(/balance/i);
    expect(await h.balanceOf(store)).toBe(0);
  });

  it('the confirmation queue (claim, then the outcome) takes it, and refuses when short', async () => {
    const store = await h.payPerOrderStore({ balance: FEE });
    const first = await h.placed(store);
    const second = await h.placed(store);
    const tasks = await db.ConfirmationTask.findAll({ where: { workspaceId: store.wid } });
    const taskOf = (orderId) => tasks.find((t) => t.orderId === orderId);
    const call = async (orderId) => {
      const base = `/api/v1/workspaces/${store.wid}/confirmation-tasks/${taskOf(orderId).id}`;
      expect((await request(app).post(`${base}/claim`).set(h.bearer(store.token)).send({})).status).toBe(200);
      return request(app).post(`${base}/outcome`).set(h.bearer(store.token)).send({ outcome: 'confirmed' });
    };
    expect((await call(first.id)).status).toBe(200);
    const refused = await call(second.id);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('ORDER_LOCKED');
    expect((await db.ConfirmationTask.findByPk(taskOf(second.id).id)).status).not.toBe('done');
    expect(await h.feeEntries(first.id)).toHaveLength(1);
    expect(await h.feeEntries(second.id)).toHaveLength(0);
  });

  it("the customer's WhatsApp button does not confirm when the fee cannot be paid; the team is told", async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    const order = await h.placed(store);
    const conversation = await db.WhatsappConversation.create({ workspaceId: store.wid, phoneNormalized: '201000007777' });
    // The confirmation message: only an answer to it counts (quickReplyConfirmation.js).
    await db.WhatsappMessage.create({
      workspaceId: store.wid,
      conversationId: conversation.id,
      direction: 'out',
      type: 'template',
      templateName: 'order_confirmation',
      status: 'sent',
      orderId: order.id,
      waMessageId: `wamid.${crypto.randomUUID()}`,
    });
    const sent = await db.WhatsappMessage.findOne({ where: { orderId: order.id } });
    const quickReply = require('../../src/modules/whatsapp/quickReplyConfirmation');
    const result = await quickReply.process({
      workspaceId: store.wid,
      payload: { intent: 'confirm', isButton: true, phoneNormalized: '201000007777', repliedToWaMessageId: sent.waMessageId },
    });
    expect(result).toMatchObject({ done: false, orderId: order.id });
    expect((await db.Order.findByPk(order.id)).confirmationState).toBe('pending');
    expect(await db.MerchantNotification.count({ where: { workspaceId: store.wid, type: 'automation' } })).toBe(1);
    expect(await h.feeEntries(order.id)).toHaveLength(0);
  });

  it('a rejection corrected to confirmed takes the fee (once), and a second correction takes nothing more', async () => {
    const store = await h.payPerOrderStore({ balance: 1000 });
    const order = await h.placed(store);
    expect((await h.confirm(store, order.id)).status).toBe(200);
    const task = await db.ConfirmationTask.findOne({ where: { orderId: order.id } });
    const correct = (outcome) =>
      request(app)
        .post(`/api/v1/workspaces/${store.wid}/confirmation-tasks/${task.id}/correction`)
        .set(h.bearer(store.token))
        .send({ outcome, reason: 'Called again' });
    expect((await correct('rejected')).status).toBe(200);
    expect((await correct('confirmed')).status).toBe(200);
    expect((await h.feeEntries(order.id)).map((e) => e.entryType)).toEqual(['order_confirm_fee']);
    expect(await h.balanceOf(store)).toBe(1000 - FEE);
  });
});

describe('never given back', () => {
  it('cancelling a confirmed order keeps its fee, and its details stay visible with a zero balance', async () => {
    const store = await h.payPerOrderStore({ balance: FEE });
    const order = await h.placed(store);
    expect((await h.confirm(store, order.id)).status).toBe(200);
    const cancel = await request(app)
      .post(`/api/v1/workspaces/${store.wid}/orders/${order.id}/cancel`)
      .set(h.bearer(store.token))
      .send({ reason: 'Customer changed their mind' });
    expect(cancel.status).toBe(200);
    expect((await h.feeEntries(order.id)).map((e) => e.entryType)).toEqual(['order_confirm_fee']);
    expect(await h.balanceOf(store)).toBe(0);
    const shown = await h.getOrder(store, order.id);
    expect(shown.contactLocked).toBe(false);
    expect(shown.contactSnapshot.phone).toBe(h.CONTACT.phone);
  });
});

describe('orders that paid a fee when they were placed, before the switch', () => {
  it('are not charged again when confirmed; one never confirmed still gets its fee back when cancelled', async () => {
    env.ordersLock.enabled = false;
    const store = await h.payPerOrderStore({ balance: 1000 });
    const old = await h.placed(store);
    const oldPending = await h.placed(store);
    expect((await h.feeEntries(old.id)).map((e) => e.entryType)).toEqual(['order_fee']);
    env.ordersLock.enabled = true;

    expect((await h.confirm(store, old.id)).status).toBe(200);
    expect((await h.feeEntries(old.id)).map((e) => e.entryType)).toEqual(['order_fee']);
    expect((await db.Order.findByPk(old.id)).contactLock).toBe('unlocked');

    await request(app).post(`/api/v1/workspaces/${store.wid}/orders/${oldPending.id}/cancel`).set(h.bearer(store.token)).send({ reason: 'Duplicate' });
    expect((await h.feeEntries(oldPending.id)).map((e) => e.entryType)).toEqual(['order_fee', 'order_fee_reversal']);
    expect(await h.balanceOf(store)).toBe(1000 - FEE);
    await expectLedgerMatches();
  });
});

describe('an order paid online while the fee could not be paid', () => {
  async function paidOnline(store) {
    const order = await h.placed(store, { paymentMethod: 'card' });
    // A payment started and captured from the dashboard (payments/paymentService): paid in full.
    const init = await request(app).post(`/api/v1/workspaces/${store.wid}/orders/${order.id}/payments`).set(h.bearer(store.token)).send({});
    const captured = await request(app)
      .post(`/api/v1/workspaces/${store.wid}/payments/${init.body.payment.id}/capture`)
      .set(h.bearer(store.token))
      .send({});
    if (captured.status !== 200) throw new Error(`capture failed: ${captured.status} ${JSON.stringify(captured.body)}`);
    return order;
  }

  it('is due and locked, and the next top-up takes its fee and opens it', async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    const order = await paidOnline(store);
    const row = await db.Order.findByPk(order.id);
    expect(row.financialState).toBe('paid');
    expect(row.contactLock).toBe('due');
    expect((await h.getOrder(store, order.id)).contactLocked).toBe(true);

    await h.topUp(store, 500);
    // The settle runs after the top-up commits.
    await confirmFee.settleDue(store.wid);
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('unlocked');
    expect((await h.feeEntries(order.id)).map((e) => [e.entryType, Number(e.cashDelta)])).toEqual([['order_confirm_fee', -FEE]]);
    expect(await h.balanceOf(store)).toBe(500 - FEE);
    expect((await h.getOrder(store, order.id)).contactLocked).toBe(false);
  });

  it('is settled from the dashboard when the balance already covers it (POST /orders/locked/settle)', async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    const order = await paidOnline(store);
    // Money arrived without a top-up entry the settle hears about: a correction written straight in.
    await db.sequelize.transaction(async (t) => {
      const w = await wallet.lockWallet(store.wid, t);
      await db.WalletLedgerEntry.create(
        { workspaceId: store.wid, entryType: 'adjustment', cashDelta: 300, balanceAfter: 300, currency: 'EGP', idempotencyKey: `adj:${crypto.randomUUID()}` },
        { transaction: t }
      );
      await w.update({ cashBalance: 300 }, { transaction: t });
    });
    const summary = await request(app).get(`/api/v1/workspaces/${store.wid}/orders/locked-summary`).set(h.bearer(store.token));
    expect(summary.body.locked).toMatchObject({ enabled: true, mode: 'pay_per_order', canPay: true, count: 1, due: 1 });
    const res = await request(app).post(`/api/v1/workspaces/${store.wid}/orders/locked/settle`).set(h.bearer(store.token)).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ settled: 1, locked: { count: 0, due: 0 } });
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('unlocked');
  });

  it('is opened for good by a renewal (the console extends the period), with no fee taken', async () => {
    const store = await h.monthlyStore({ lapsed: true });
    const order = await paidOnline(store);
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('due');

    const admin = await makePlatformUser('admin');
    const ext = await request(app)
      .post(`/api/v1/admin/workspaces/${store.wid}/subscription/extend`)
      .set(admin.H)
      .send({ duration: { months: 1 }, note: 'Paid by transfer' });
    expect(ext.status).toBe(201);
    // The release runs once the console's transaction has committed.
    expect(await eventually(async () => (await db.Order.findByPk(order.id)).contactLock === 'unlocked')).toBe(true);
    expect(await h.feeEntries(order.id)).toEqual([]);
    // Lapsing again does not lock it: it was settled.
    await h.lapse(store);
    expect((await h.getOrder(store, order.id)).contactLocked).toBe(false);
  });

  it("a renewal's release takes no fee from a store that is on pay per order by the time it reads the order", async () => {
    const store = await h.payPerOrderStore({ balance: 0 });
    const order = await paidOnline(store);
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('due');
    // The balance can pay now, but nothing settled it: a correction written straight in.
    await db.sequelize.transaction(async (t) => {
      const w = await wallet.lockWallet(store.wid, t);
      await db.WalletLedgerEntry.create(
        { workspaceId: store.wid, entryType: 'adjustment', cashDelta: 300, balanceAfter: 300, currency: 'EGP', idempotencyKey: `adj:${crypto.randomUUID()}` },
        { transaction: t }
      );
      await w.update({ cashBalance: 300 }, { transaction: t });
    });
    // The release's first look sees an entitled store (a renewal that just committed); by the time it
    // reads the order the store pays per order (a switch applied in between).
    const spy = jest.spyOn(orderLock, 'contextFor').mockImplementationOnce(async () => ({ enabled: true, mode: 'open', canPay: true }));
    try {
      expect(await confirmFee.settleDue(store.wid, { takeFees: false })).toEqual({ settled: 0, left: 1 });
    } finally {
      spy.mockRestore();
    }
    expect((await db.Order.findByPk(order.id)).contactLock).toBe('due');
    expect((await h.feeEntries(order.id)).filter((e) => e.entryType === 'order_confirm_fee')).toEqual([]);
    expect(await h.balanceOf(store)).toBe(300);

    // Its fee waits for the merchant's own settle (or a top-up), as before.
    expect(await confirmFee.settleDue(store.wid)).toEqual({ settled: 1, left: 0 });
    expect(await h.balanceOf(store)).toBe(300 - FEE);
  });
});

describe('a funnel add-on placed as its own order', () => {
  it('pays its own fee while the order it follows is pending, and none once that order is settled', async () => {
    const store = await h.payPerOrderStore({ balance: 1000 });
    const parent = await h.placed(store);
    const addOn = await h.placed(store);
    await db.Order.update({ source: 'upsell', linkedFromOrderId: parent.id }, { where: { id: addOn.id } });
    expect((await h.confirm(store, addOn.id)).status).toBe(200);
    expect((await h.feeEntries(addOn.id)).map((e) => e.entryType)).toEqual(['order_confirm_fee']);

    expect((await h.confirm(store, parent.id)).status).toBe(200);
    const second = await h.placed(store);
    await db.Order.update({ source: 'upsell', linkedFromOrderId: parent.id }, { where: { id: second.id } });
    expect((await h.confirm(store, second.id)).status).toBe(200);
    expect(await h.feeEntries(second.id)).toEqual([]);
    expect((await db.Order.findByPk(second.id)).contactLock).toBe('unlocked');
    expect(await h.balanceOf(store)).toBe(1000 - 2 * FEE);
  });
});

describe('an order whose fee was taken when it was placed, before the switch', () => {
  it('shows while still pending though the balance cannot pay another fee, and is not counted as locked', async () => {
    env.ordersLock.enabled = false;
    const store = await h.payPerOrderStore({ balance: FEE });
    const old = await h.placed(store);
    expect((await h.feeEntries(old.id)).map((e) => e.entryType)).toEqual(['order_fee']);
    expect(await h.balanceOf(store)).toBe(0);
    env.ordersLock.enabled = true;

    expect((await h.getOrder(store, old.id)).contactLocked).toBe(false);
    const fresh = await h.placed(store);
    expect((await h.getOrder(store, fresh.id)).contactLocked).toBe(true);
    const summary = await request(app).get(`/api/v1/workspaces/${store.wid}/orders/locked-summary`).set(h.bearer(store.token));
    expect(summary.body.locked).toMatchObject({ count: 1 });
  });
});

describe('with the switch off', () => {
  it('the fee is charged when the order is placed, as before, and confirming adds nothing', async () => {
    env.ordersLock.enabled = false;
    const store = await h.payPerOrderStore({ balance: 1000 });
    const order = await h.placed(store);
    expect((await h.confirm(store, order.id)).status).toBe(200);
    expect((await h.feeEntries(order.id)).map((e) => e.entryType)).toEqual(['order_fee']);
    const shown = await h.getOrder(store, order.id);
    expect(shown).not.toHaveProperty('contactLocked');
  });
});
