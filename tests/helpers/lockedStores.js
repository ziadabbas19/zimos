'use strict';

// Stores in every standing the locked-orders rule knows (orders/orderLock.js):
// pay per order with or without a balance, a monthly plan running or lapsed.
// For ordersLock*.test.js.

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct } = require('./factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');

const FEE = 75;
const DAY = 24 * 60 * 60 * 1000;
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const key = () => `lock-${Date.now()}-${(seq += 1)}-${Math.random().toString(36).slice(2)}`;

/** Locked orders and the wallet on, for one test file's tests. */
function switchOn() {
  beforeEach(() => {
    env.wallet.enabled = true;
    env.ordersLock.enabled = true;
  });
  afterEach(() => {
    env.wallet.enabled = false;
    env.ordersLock.enabled = false;
  });
}

async function planWith(fields = {}) {
  return db.Plan.create({
    key: `lock-${(seq += 1)}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Plan',
    monthlyPriceAmount: 0,
    yearlyPriceAmount: 0,
    currency: 'EGP',
    isPublic: false,
    isActive: true,
    perOrderFeeAmount: 0,
    ...fields,
  });
}

async function storeWith(subscription, { stock = 50 } = {}) {
  const setup = await setupWorkspaceWithProduct({ stock });
  await db.Subscription.update({ trialEndsAt: null, ...subscription }, { where: { workspaceId: setup.workspace.id } });
  return { ...setup, wid: setup.workspace.id, token: setup.auth.accessToken };
}

const farFuture = () => new Date(Date.now() + 50 * 365 * DAY);

/** Pay per order: the fee FEE, `freeOrders` free, and a balance of `balance` (minor units). */
async function payPerOrderStore({ balance = 0, freeOrders = 0, stock } = {}) {
  const plan = await planWith({ name: 'Pay per order', perOrderFeeAmount: FEE, walletFreeOrders: freeOrders });
  const store = await storeWith({ planId: plan.id, status: 'active', currentPeriodEnd: farFuture() }, { stock });
  if (balance) await topUp(store, balance);
  return { ...store, plan };
}

/** A monthly plan; `lapsed` puts its period three days behind (past the grace day). */
async function monthlyStore({ lapsed = false, stock } = {}) {
  const plan = await planWith({ name: 'Monthly', monthlyPriceAmount: 50000 });
  const end = lapsed ? new Date(Date.now() - 3 * DAY) : new Date(Date.now() + 20 * DAY);
  const store = await storeWith({ planId: plan.id, status: 'active', currentPeriodEnd: end }, { stock });
  return { ...store, plan };
}

async function lapse(store) {
  await db.Subscription.update({ currentPeriodEnd: new Date(Date.now() - 3 * DAY) }, { where: { workspaceId: store.wid } });
}

async function renew(store) {
  await db.Subscription.update({ status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * DAY) }, { where: { workspaceId: store.wid } });
}

/** A top-up approved in the console, as walletService.creditTopup records it. */
async function topUp(store, amount) {
  const proof = { id: crypto.randomUUID(), workspaceId: store.wid, methodCode: 'instapay' };
  await db.sequelize.transaction((t) => wallet.creditTopup(proof, amount, null, t));
}

const CONTACT = { fullName: 'Locked Buyer', phone: '01000007777', email: 'buyer@example.com' };
const ADDRESS = { country: 'EG', province: 'Giza', city: 'Dokki', addressLine: '12 Tahrir St', notes: 'Ring twice' };

/** An order typed in the dashboard (COD unless said). Resolves the response. */
function staffOrder(store, { paymentMethod = 'cod', contact = CONTACT, notes = 'Leave at the door' } = {}) {
  return request(app)
    .post(`/api/v1/workspaces/${store.wid}/orders`)
    .set(bearer(store.token))
    .set('Idempotency-Key', key())
    .send({ items: [{ variantId: store.variant.id, quantity: 1 }], contact, shippingAddress: ADDRESS, paymentMethod, notes });
}

/** A shopper's COD checkout on the storefront. */
function shopperOrder(store, { contact = CONTACT } = {}) {
  return request(app)
    .post(`/api/v1/store/${store.wid}/checkout`)
    .set('Idempotency-Key', key())
    .send({ item: { variantId: store.variant.id, quantity: 1 }, contact, shippingAddress: ADDRESS, paymentMethod: 'cod' });
}

async function placed(store, opts) {
  const res = await staffOrder(store, opts);
  if (res.status !== 201) throw new Error(`staffOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
}

const confirm = (store, orderId) =>
  request(app).post(`/api/v1/workspaces/${store.wid}/orders/${orderId}/confirmation`).set(bearer(store.token)).send({});

const getOrder = async (store, orderId) =>
  (await request(app).get(`/api/v1/workspaces/${store.wid}/orders/${orderId}`).set(bearer(store.token))).body.order;

const balanceOf = async (store) => {
  const row = await db.WorkspaceWallet.findOne({ where: { workspaceId: store.wid } });
  return row ? Number(row.cashBalance) : 0;
};

const feeEntries = (orderId) => db.WalletLedgerEntry.findAll({ where: { orderId }, order: [['createdAt', 'ASC']] });

module.exports = {
  FEE,
  DAY,
  CONTACT,
  ADDRESS,
  bearer,
  key,
  switchOn,
  planWith,
  payPerOrderStore,
  monthlyStore,
  lapse,
  renew,
  topUp,
  staffOrder,
  shopperOrder,
  placed,
  confirm,
  getOrder,
  balanceOf,
  feeEntries,
};
