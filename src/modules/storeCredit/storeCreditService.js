'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * Store credit: money a customer holds at the store, in
 * the store currency (customers.store_credit_amount, minor units).
 *
 * - In: staff give or take credit (with a note), or refund an order to store
 *   credit instead of money — a normal refund of the order (it counts in
 *   amountRefunded, a credit note is issued) whose value goes onto the
 *   customer's balance.
 * - Out: a signed-in shopper (shopperAccounts) spends it at checkout, as a
 *   captured `store_credit` payment, with cash on delivery (it is not held
 *   against an online payment). Refunding that payment, or cancelling the
 *   order, puts it back.
 * - settings.store_credit.enabled (default on) lets shoppers spend it.
 * - Off (STORE_FEATURES without store_credit): nothing is spent or given;
 *   credit already spent still comes back on a refund or a cancel.
 */

const spendingOn = (workspace) => storeFeatureOn('store_credit') && !(workspace && workspace.settings && workspace.settings.store_credit && workspace.settings.store_credit.enabled === false);

async function currencyOf(workspaceId, transaction = null) {
  const w = await db.Workspace.findByPk(workspaceId, { attributes: ['defaultCurrency'], transaction });
  return (w && w.defaultCurrency) || 'EGP';
}

/** Moves a balance (locked) and writes the ledger line; never below 0 unless `strict` refuses. */
async function move(customerId, amount, kind, extra, transaction, { strict = false } = {}) {
  const customer = await db.Customer.findByPk(customerId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!customer) throw new NotFoundError('Customer');
  const current = Number(customer.storeCreditAmount);
  if (strict && current + amount < 0) throw new AppError('STORE_CREDIT_NOT_ENOUGH', `The balance is ${current}`, 422, [{ field: 'amount', message: 'More than the balance' }]);
  const balance = Math.max(0, current + amount);
  await customer.update({ storeCreditAmount: balance }, { transaction, hooks: false });
  const row = await db.StoreCreditTransaction.create(
    { workspaceId: customer.workspaceId, customerId, kind, amount: balance - current, balanceAfter: balance, currency: extra.currency || (await currencyOf(customer.workspaceId, transaction)), ...extra },
    { transaction }
  );
  return { customer, row, applied: balance - current, balance };
}

// ----------------------------------------------------------------- staff --

async function adjust(workspaceId, customerId, amount, note, req) {
  const customer = await db.Customer.findOne({ where: { id: customerId, workspaceId } });
  if (!customer) throw new NotFoundError('Customer');
  // A customer who comes hidden: a grant would put them in the holders' list, by name (orders/orderLock).
  await require('../orders/orderLock').assertCustomerVisible(workspaceId, customer.id);
  const out = await db.sequelize.transaction((t) => move(customer.id, amount, amount > 0 ? 'grant' : 'adjust', { note, actorUserId: req.user.id }, t, { strict: true }));
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'store_credit.adjust', entityType: 'Customer', entityId: customer.id, after: { amount, balance: out.balance, note }, req });
  return { balance: String(out.balance), applied: String(out.applied) };
}

/** Refunds `amount` of an order as store credit to its customer (a processed refund, no money moves). */
async function refundToCredit(workspaceId, orderId, { amount, reason }, req) {
  const out = await db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order) throw new NotFoundError('Order');
    if (!order.customerId) throw new AppError('ORDER_HAS_NO_CUSTOMER', 'This order has no customer to credit', 422);
    if (order.currency !== (await currencyOf(workspaceId, transaction))) throw new AppError('STORE_CREDIT_CURRENCY', 'Store credit is in the store currency only', 422);
    const eligible = Number(order.amountPaid) - Number(order.amountRefunded);
    if (amount > eligible) throw new AppError('REFUND_EXCEEDS_ELIGIBLE_AMOUNT', `Cannot refund ${amount}; only ${Math.max(0, eligible)} was paid and not refunded`, 422);
    const refund = await db.Refund.create(
      { workspaceId, orderId: order.id, paymentId: null, amount, reason: `Store credit: ${reason}`.slice(0, 500), status: 'processed', processedAt: new Date(), source: 'merchant', processedByUserId: req.user.id },
      { transaction }
    );
    const creditNote = await require('../invoices/invoiceService').creditNoteForRefund(refund, transaction);
    if (creditNote) await refund.update({ creditNoteId: creditNote.id }, { transaction });
    const amountRefunded = Number(order.amountRefunded) + Number(amount);
    await order.update({ amountRefunded }, { transaction });
    await require('../orders/orderStateService').setFinancialState(workspaceId, order.id, amountRefunded >= Number(order.totalAmount) ? 'refunded' : 'partially_refunded', req, transaction);
    const moved = await move(order.customerId, Number(amount), 'refund_credit', { orderId: order.id, refundId: refund.id, note: reason.slice(0, 200), actorUserId: req.user.id, currency: order.currency }, transaction);
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'order.refund_to_store_credit', entityType: 'Refund', entityId: refund.id, after: { amount, reason, balance: moved.balance }, req, transaction });
    return { refund, balance: moved.balance };
  });
  return { refund: { id: out.refund.id, amount: String(out.refund.amount), status: out.refund.status, reason: out.refund.reason }, balance: String(out.balance) };
}

// ---------------------------------------------------------------- spend --

async function assertCanSpend(workspace, shopper) {
  if (!spendingOn(workspace)) throw new AppError('STORE_CREDIT_OFF', 'Store credit cannot be used here', 422, [{ field: 'useStoreCredit', message: 'Store credit cannot be used here' }]);
  if (!shopper) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in to use your store credit', 401, [{ field: 'useStoreCredit', message: 'Sign in to use your store credit' }]);
  if (Number(shopper.storeCreditAmount) <= 0) throw new AppError('STORE_CREDIT_EMPTY', 'You have no store credit', 422, [{ field: 'useStoreCredit', message: 'You have no store credit' }]);
  return shopper;
}

/** Spends up to `max` (or all) of the customer's credit on the order, as a captured payment. */
async function spendOnOrder(order, customerId, { max = null, req = null } = {}) {
  if (!storeFeatureOn('store_credit')) return { applied: false, reason: 'unavailable' };
  try {
    return await db.sequelize.transaction(async (transaction) => {
      const locked = await db.Order.findOne({ where: { id: order.id }, transaction, lock: transaction.LOCK.UPDATE });
      if (locked.currency !== (await currencyOf(locked.workspaceId, transaction))) return { applied: false, reason: 'currency' };
      const due = Number(locked.totalAmount) - Number(locked.amountPaid);
      const customer = await db.Customer.findByPk(customerId, { transaction, lock: transaction.LOCK.UPDATE });
      const amount = Math.min(Number(customer.storeCreditAmount), Math.max(0, due), max === null ? Infinity : Number(max));
      if (amount <= 0) return { applied: false, reason: 'nothing_due' };
      const payment = await db.Payment.create(
        { workspaceId: locked.workspaceId, orderId: locked.id, providerCode: 'store_credit', status: 'captured', amount, currency: locked.currency, providerReference: `${customerId}:${locked.id}`, maskedDisplay: 'Store credit', method: 'store_credit', paidAt: new Date() },
        { transaction }
      );
      const { balance } = await move(customerId, -amount, 'redeem', { orderId: locked.id, paymentId: payment.id, currency: locked.currency }, transaction);
      const amountPaid = Number(locked.amountPaid) + amount;
      await locked.update({ amountPaid }, { transaction });
      await require('../orders/orderStateService').setFinancialState(locked.workspaceId, locked.id, amountPaid >= Number(locked.totalAmount) ? 'paid' : 'partially_paid', req, transaction);
      return { applied: true, amount: String(amount), balance: String(balance), currency: locked.currency, paymentId: payment.id };
    });
  } catch (err) {
    logger.error('[store-credit] spend failed', { orderId: order.id, message: err.message });
    return { applied: false, reason: 'error' };
  }
}

// -------------------------------------------------- refunds and cancels --

async function onRefundProcessed(refund, options = {}) {
  if (refund.status !== 'processed' || !refund.paymentId) return;
  if (options.fields && !options.fields.includes('status')) return;
  const transaction = options.transaction || null;
  const payment = await db.Payment.findByPk(refund.paymentId, { transaction });
  if (!payment || payment.providerCode !== 'store_credit') return;
  if (await db.StoreCreditTransaction.count({ where: { refundId: refund.id, kind: 'refund' }, transaction })) return;
  const customerId = String(payment.providerReference || '').split(':')[0];
  const run = (t) => move(customerId, Number(refund.amount), 'refund', { orderId: refund.orderId, paymentId: payment.id, refundId: refund.id, currency: payment.currency }, t);
  if (transaction) await run(transaction);
  else await db.sequelize.transaction(run);
}
let hooked = false;
function install() {
  if (hooked) return;
  hooked = true;
  db.Refund.addHook('afterCreate', 'zimosStoreCreditRefund', onRefundProcessed);
  db.Refund.addHook('afterUpdate', 'zimosStoreCreditRefund', onRefundProcessed);
}
install();

async function onOrderCancelled(event) {
  const p = event.payload || {};
  const workspaceId = event.workspaceId || p.workspaceId;
  if (!workspaceId || !p.orderId) return null;
  // Most orders were paid by no credit: nothing to lock for them.
  if (!(await db.Payment.count({ where: { workspaceId, orderId: p.orderId, providerCode: 'store_credit' } }))) return null;
  await db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: p.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    // Only a cancelled or rejected order gives its tender back: a reopen that beat this job keeps it.
    if (!order || (!order.cancelledAt && order.confirmationState !== 'rejected')) return;
    const payments = await db.Payment.findAll({ where: { workspaceId, orderId: order.id, providerCode: 'store_credit', status: 'captured' }, transaction });
    let refundedNow = 0;
    // Never more than the order still has to refund: a refund already made counts.
    let room = Math.max(0, Number(order.amountPaid) - Number(order.amountRefunded));
    for (const payment of payments) {
      const refunded = await db.Refund.sum('amount', { where: { paymentId: payment.id, status: ['processed', 'pending'] }, transaction });
      const left = Math.min(Number(payment.amount) - Number(refunded || 0), room);
      if (left <= 0) continue;
      room -= left;
      await db.Refund.create({ workspaceId, orderId: order.id, paymentId: payment.id, amount: left, reason: 'Order cancelled: store credit returned', status: 'processed', processedAt: new Date(), source: 'merchant' }, { transaction });
      refundedNow += left;
    }
    if (!refundedNow) return;
    const amountRefunded = Number(order.amountRefunded) + refundedNow;
    await order.update({ amountRefunded }, { transaction });
    await require('../orders/orderStateService').setFinancialState(workspaceId, order.id, amountRefunded >= Number(order.amountPaid) ? 'refunded' : 'partially_refunded', null, transaction);
  });
  return null;
}

// ----------------------------------------------------------------- views --

const txView = (t) => ({ id: t.id, kind: t.kind, amount: String(t.amount), balanceAfter: String(t.balanceAfter), currency: t.currency, orderId: t.orderId, note: t.note, createdAt: t.createdAt });

async function accountOf(customer, limit = 50) {
  const history = await db.StoreCreditTransaction.findAll({ where: { customerId: customer.id, kind: { [Op.ne]: 'hold_released' } }, order: [['createdAt', 'DESC']], limit });
  return { balance: String(customer.storeCreditAmount), currency: await currencyOf(customer.workspaceId), history: history.map(txView) };
}

async function listHolders(workspaceId) {
  const rows = await db.Customer.findAll({ where: { workspaceId, storeCreditAmount: { [Op.gt]: 0 } }, attributes: ['id', 'fullName', 'phoneNormalized', 'email', 'storeCreditAmount'], order: [['storeCreditAmount', 'DESC']], limit: 500 });
  const total = Number(await db.Customer.sum('storeCreditAmount', { where: { workspaceId } })) || 0;
  const orderLock = require('../orders/orderLock');
  // A holder who comes hidden shows the balance, not who they are (orders/orderLock).
  const customers = await orderLock.presentCustomers(
    workspaceId,
    rows.map((c) => ({ customerId: c.id, fullName: c.fullName, phone: c.phoneNormalized, email: c.email, balance: String(c.storeCreditAmount) })),
    { pick: (r) => r.customerId, mask: (r) => orderLock.maskFields(r, ['fullName', 'phone', 'email']) }
  );
  return { customers, outstanding: String(total), currency: await currencyOf(workspaceId) };
}

module.exports = { spendingOn, move, adjust, refundToCredit, assertCanSpend, spendOnOrder, onRefundProcessed, onOrderCancelled, accountOf, listHolders, install };
