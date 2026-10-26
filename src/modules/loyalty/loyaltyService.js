'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');
const access = require('./loyaltyAccess');

/*
 * Loyalty points. settings.loyalty =
 *   { enabled, earnPointsPerUnit,   points per 1 unit of the store currency spent (e.g. 1 point per EGP 1)
 *     pointValue,                   what 1 point is worth, in minor units (e.g. 10 = EGP 0.10)
 *     minRedeemPoints, maxRedeemPercent (1–100 of the order total),
 *     maxRedeemPointsPerOrder,      the most points one order takes (null = no cap but the percent)
 *     expiryDays }                  a balance expires after that many days with no earn or spend (null = never)
 * The merchant sets every amount; nothing is assumed in code.
 *
 * - Earn: when an order is delivered, its customer gets points on what they
 *   paid for goods (total − shipping − refunded − what points paid), once per
 *   order. A return or a cancellation after that takes them back.
 * - Spend: a signed-in shopper (shopperAccounts) uses points at checkout. They
 *   become a captured `loyalty` payment like a gift card, with cash on
 *   delivery (they are not held against an online payment). Refunding that
 *   payment gives the points back; a cancelled order returns them.
 * - Only orders in the store's own currency earn or spend points.
 * - Off (STORE_FEATURES without loyalty): nothing is earned, spent or
 *   expired; points already spent still come back on a refund or a cancel.
 * - Frozen (loyaltyAccess.js: the plan lacks `loyalty`, or the subscription
 *   stopped, each behind its own switch): the same, but the balances still
 *   show, to the merchant and to the shopper.
 * - An order locked when it is delivered (orders/orderLock.js,
 *   ORDERS_LOCK_ENABLED) earns nothing.
 */

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.loyalty) || {};
  const earn = Number(s.earnPointsPerUnit) || 0;
  const value = Number.isInteger(s.pointValue) ? s.pointValue : 0;
  return {
    enabled: storeFeatureOn('loyalty') && Boolean(s.enabled) && earn > 0 && value > 0,
    earnPointsPerUnit: earn || null,
    pointValue: value || null,
    minRedeemPoints: Number.isInteger(s.minRedeemPoints) ? s.minRedeemPoints : 1,
    maxRedeemPercent: Number.isInteger(s.maxRedeemPercent) ? s.maxRedeemPercent : 100,
    maxRedeemPointsPerOrder: Number.isInteger(s.maxRedeemPointsPerOrder) && s.maxRedeemPointsPerOrder > 0 ? s.maxRedeemPointsPerOrder : null,
    expiryDays: Number.isInteger(s.expiryDays) ? s.expiryDays : null,
  };
}

async function workspaceOf(workspaceId, transaction = null) {
  return db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'settings', 'defaultCurrency'], transaction });
}

/** Moves a customer's balance by `points` (locked), writing the ledger line. Never below 0. */
async function move(customerId, points, kind, extra, transaction) {
  const customer = await db.Customer.findByPk(customerId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!customer) throw new NotFoundError('Customer');
  const balance = Math.max(0, Number(customer.loyaltyPoints) + points);
  const applied = balance - Number(customer.loyaltyPoints);
  await customer.update({ loyaltyPoints: balance, ...(['earn', 'redeem', 'hold', 'adjust'].includes(kind) ? { loyaltyActivityAt: new Date() } : {}) }, { transaction, hooks: false });
  const row = await db.LoyaltyTransaction.create({ workspaceId: customer.workspaceId, customerId, kind, points: applied, balanceAfter: balance, ...extra }, { transaction });
  return { customer, row, applied, balance };
}

// ----------------------------------------------------------------- earn --

async function earnForOrder(event) {
  const p = event.payload || {};
  const workspaceId = event.workspaceId || p.workspaceId;
  if (!workspaceId || !p.orderId) return null;
  const workspace = await workspaceOf(workspaceId);
  const s = settingsOf(workspace);
  if (!s.enabled || (await access.frozenReason(workspaceId))) return null;
  await db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: p.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!order || !order.customerId || order.isTest || order.cancelledAt || order.currency !== workspace.defaultCurrency) return;
    if (await db.LoyaltyTransaction.count({ where: { orderId: order.id, kind: 'earn' }, transaction })) return;
    // A locked order (the store's subscription lapsed) earns nothing; false without a query while ORDERS_LOCK_ENABLED is off.
    if (await require('../orders/orderLock').isOrderLocked(workspaceId, order.id, { transaction })) return;
    if (access.guardOn() && access.customerBlocked(await db.Customer.findByPk(order.customerId, { attributes: ['id', 'isBlacklisted'], transaction }))) return;
    const paidByPoints = Number(await db.Payment.sum('amount', { where: { orderId: order.id, providerCode: 'loyalty', status: ['captured', 'partially_refunded'] }, transaction })) || 0;
    const base = Number(order.totalAmount) - Number(order.shippingAmount) - Number(order.amountRefunded) - paidByPoints;
    // A VIP tier may multiply the points (vipTiers/).
    const multiplier = await require('../vipTiers').pointsMultiplier(workspace, order.customerId);
    const points = Math.floor((Math.max(0, base) / 100) * s.earnPointsPerUnit * multiplier);
    if (points <= 0) return;
    await move(order.customerId, points, 'earn', { orderId: order.id, note: order.orderNumber ? String(order.orderNumber).slice(0, 200) : null }, transaction);
  });
  return null;
}

/** order.returned / order.cancelled: the points the order earned go back out (as far as the balance has them). */
async function reverseEarned(orderId, transaction, note) {
  const earned = await db.LoyaltyTransaction.findOne({ where: { orderId, kind: 'earn' }, transaction });
  if (!earned || (await db.LoyaltyTransaction.count({ where: { orderId, kind: 'reverse' }, transaction }))) return;
  await move(earned.customerId, -Number(earned.points), 'reverse', { orderId, note }, transaction);
}

// ---------------------------------------------------------------- spend --

const refusePoints = (code, message) => new AppError(code, message, 422, [{ field: 'loyaltyPoints', message }]);

/**
 * Checkout, before the order: the signed-in shopper can use `points`.
 * `deviceId` is the checkout's (risk/botProtection), for the guard. Returns the customer.
 */
async function assertCanSpend(workspace, shopper, points, { deviceId = null } = {}) {
  const s = settingsOf(workspace);
  if (!s.enabled) throw refusePoints('LOYALTY_OFF', 'This store has no loyalty points');
  if (!shopper) throw new AppError('SHOPPER_NOT_SIGNED_IN', 'Sign in to use your points', 401, [{ field: 'loyaltyPoints', message: 'Sign in to use your points' }]);
  // Frozen: the balance shows, but nothing is spent until the store has the programme back.
  if (await access.frozenReason(workspace.id)) throw refusePoints('LOYALTY_FROZEN', 'Points cannot be used in this store right now');
  if (points < s.minRedeemPoints) throw refusePoints('LOYALTY_TOO_FEW', `Use at least ${s.minRedeemPoints} points`);
  if (points > Number(shopper.loyaltyPoints)) throw refusePoints('LOYALTY_NOT_ENOUGH', `You have ${shopper.loyaltyPoints} points`);
  // The guard (LOYALTY_GUARD_ENABLED). The same words for a blocked customer as for anything else unusable.
  if (access.customerBlocked(shopper)) throw refusePoints('LOYALTY_UNAVAILABLE', 'Points cannot be used on this order');
  if (await access.deviceSpentForOther(workspace.id, shopper.id, deviceId)) {
    throw refusePoints('LOYALTY_DEVICE_LIMIT', `Points from another account were used on this device in the last ${access.DEVICE_WINDOW_HOURS} hours`);
  }
  return shopper;
}

/** How many of `points` an order can take, and their worth: { points, amount }. */
function planFor(s, order, points, due) {
  const cap = Math.min(Math.floor((Number(order.totalAmount) * s.maxRedeemPercent) / 100), Math.max(0, due));
  const usable = Math.min(points, Math.floor(cap / s.pointValue), s.maxRedeemPointsPerOrder || Infinity);
  return { points: usable, amount: usable * s.pointValue };
}

/** Takes `points` off the shopper for this order, as a captured payment. */
async function spendOnOrder(order, customerId, points, { req = null } = {}) {
  try {
    return await db.sequelize.transaction(async (transaction) => {
      const locked = await db.Order.findOne({ where: { id: order.id }, transaction, lock: transaction.LOCK.UPDATE });
      const workspace = await workspaceOf(locked.workspaceId, transaction);
      const s = settingsOf(workspace);
      if (!s.enabled || locked.currency !== workspace.defaultCurrency) return { applied: false, reason: 'unusable' };
      // Frozen since the checkout's own check (a plan change in between): the order stands, unpaid by points.
      if (await access.frozenReason(locked.workspaceId, { transaction })) return { applied: false, reason: 'frozen' };
      const due = Number(locked.totalAmount) - Number(locked.amountPaid);
      const customer = await db.Customer.findByPk(customerId, { transaction, lock: transaction.LOCK.UPDATE });
      const plan = planFor(s, locked, Math.min(points, Number(customer.loyaltyPoints)), due);
      if (plan.points <= 0) return { applied: false, reason: 'nothing_due' };
      const payment = await db.Payment.create(
        { workspaceId: locked.workspaceId, orderId: locked.id, providerCode: 'loyalty', status: 'captured', amount: plan.amount, currency: locked.currency, providerReference: `${customerId}:${locked.id}`, maskedDisplay: `${plan.points} points`, method: 'loyalty', paidAt: new Date() },
        { transaction }
      );
      const { balance } = await move(customerId, -plan.points, 'redeem', { orderId: locked.id, paymentId: payment.id, amount: plan.amount, currency: locked.currency }, transaction);
      const amountPaid = Number(locked.amountPaid) + plan.amount;
      await locked.update({ amountPaid }, { transaction });
      await require('../orders/orderStateService').setFinancialState(locked.workspaceId, locked.id, amountPaid >= Number(locked.totalAmount) ? 'paid' : 'partially_paid', req, transaction);
      return { applied: true, points: plan.points, amount: String(plan.amount), balance, currency: locked.currency, paymentId: payment.id };
    });
  } catch (err) {
    logger.error('[loyalty] spend failed', { orderId: order.id, message: err.message });
    return { applied: false, reason: 'error' };
  }
}

// --------------------------------------------------------------- refunds --

/** A processed refund of a `loyalty` payment gives the points back (in the refund's transaction). */
async function onRefundProcessed(refund, options = {}) {
  if (refund.status !== 'processed' || !refund.paymentId) return;
  if (options.fields && !options.fields.includes('status')) return;
  const transaction = options.transaction || null;
  const payment = await db.Payment.findByPk(refund.paymentId, { transaction });
  if (!payment || payment.providerCode !== 'loyalty') return;
  const note = `refund:${refund.id}`;
  if (await db.LoyaltyTransaction.count({ where: { note }, transaction })) return;
  const spent = await db.LoyaltyTransaction.findOne({ where: { paymentId: payment.id, kind: 'redeem' }, transaction });
  if (!spent || !Number(spent.amount)) return;
  // Each refund's share, rounded, but never past the points this payment spent across all its refunds.
  const back = Number(await db.LoyaltyTransaction.sum('points', { where: { paymentId: payment.id, kind: 'refund' }, transaction })) || 0;
  const points = Math.min(Math.round((Number(refund.amount) * -Number(spent.points)) / Number(spent.amount)), -Number(spent.points) - back);
  if (points <= 0) return;
  const run = (t) => move(spent.customerId, points, 'refund', { orderId: refund.orderId, paymentId: payment.id, amount: Number(refund.amount), currency: payment.currency, note }, t);
  if (transaction) await run(transaction);
  else await db.sequelize.transaction(run);
}
let hooked = false;
function install() {
  if (hooked) return;
  hooked = true;
  db.Refund.addHook('afterCreate', 'zimosLoyaltyRefund', onRefundProcessed);
  db.Refund.addHook('afterUpdate', 'zimosLoyaltyRefund', onRefundProcessed);
}
install();

/** order.cancelled: spent points are refunded, earned points are taken back. */
async function onOrderCancelled(event) {
  const p = event.payload || {};
  const workspaceId = event.workspaceId || p.workspaceId;
  if (!workspaceId || !p.orderId) return null;
  // Most orders neither paid with points nor earned any: nothing to lock for them.
  const touched = (await db.Payment.count({ where: { workspaceId, orderId: p.orderId, providerCode: 'loyalty' } })) || (await db.LoyaltyTransaction.count({ where: { orderId: p.orderId, kind: 'earn' } }));
  if (!touched) return null;
  await db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: p.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    // Only a cancelled or rejected order gives its tender back: a reopen that beat this job keeps it.
    if (!order || (!order.cancelledAt && order.confirmationState !== 'rejected')) return;
    await reverseEarned(order.id, transaction, 'order cancelled');
    const payments = await db.Payment.findAll({ where: { workspaceId, orderId: order.id, providerCode: 'loyalty', status: 'captured' }, transaction });
    let refundedNow = 0;
    // Never more than the order still has to refund: a refund already made counts.
    let room = Math.max(0, Number(order.amountPaid) - Number(order.amountRefunded));
    for (const payment of payments) {
      const refunded = await db.Refund.sum('amount', { where: { paymentId: payment.id, status: ['processed', 'pending'] }, transaction });
      const left = Math.min(Number(payment.amount) - Number(refunded || 0), room);
      if (left <= 0) continue;
      room -= left;
      await db.Refund.create({ workspaceId, orderId: order.id, paymentId: payment.id, amount: left, reason: 'Order cancelled: points returned', status: 'processed', processedAt: new Date(), source: 'merchant' }, { transaction });
      refundedNow += left;
    }
    if (!refundedNow) return;
    const amountRefunded = Number(order.amountRefunded) + refundedNow;
    await order.update({ amountRefunded }, { transaction });
    await require('../orders/orderStateService').setFinancialState(workspaceId, order.id, amountRefunded >= Number(order.amountPaid) ? 'refunded' : 'partially_refunded', null, transaction);
  });
  return null;
}

async function onOrderReturned(event) {
  const p = event.payload || {};
  if (!p.orderId) return null;
  await db.sequelize.transaction((t) => reverseEarned(p.orderId, t, 'order returned'));
  return null;
}

/*
 * A frozen store's balances never expire. The daily job marks every frozen
 * store that has an expiry (settings.loyalty.frozenSeenAt, written alone
 * with jsonb_set so a settings save is never overwritten), and a balance's
 * inactivity counts from that mark too: a marked store's rows drop out of
 * the job, and once it has the programme back its customers get a whole
 * `expiryDays` from the last frozen day. Only the job writes the mark (the
 * settings route takes no such field).
 */
const lastActiveSql = (c, w) =>
  `GREATEST(COALESCE(${c}.loyalty_activity_at, ${c}.created_at), COALESCE((${w}.settings->'loyalty'->>'frozenSeenAt')::timestamptz, '-infinity'::timestamptz))`;

function lastActive(workspace, customer) {
  const seen = workspace.settings && workspace.settings.loyalty && workspace.settings.loyalty.frozenSeenAt;
  const activity = new Date(customer.loyaltyActivityAt || customer.createdAt).getTime();
  const mark = seen ? new Date(seen).getTime() : NaN;
  return Number.isFinite(mark) ? Math.max(activity, mark) : activity;
}

/** Daily: balances with no earn or spend for `expiryDays` expire; a frozen store's never do. */
async function expireInactive() {
  if (!storeFeatureOn('loyalty')) return;
  // Only while one of loyaltyAccess's switches is on can a store be frozen: then each store with an expiry is asked once.
  if (access.planGateOn() || access.guardOn()) {
    const stores = await db.sequelize.query(`SELECT id FROM workspaces WHERE settings->'loyalty'->>'expiryDays' IS NOT NULL`, { type: db.Sequelize.QueryTypes.SELECT });
    for (const { id } of stores) {
      if (!(await access.frozenReason(id))) continue;
      await db.sequelize.query(
        `UPDATE workspaces SET settings = jsonb_set(settings, '{loyalty,frozenSeenAt}', to_jsonb(NOW()), true)
          WHERE id = :id AND jsonb_typeof(settings->'loyalty') = 'object'`,
        { replacements: { id } }
      );
    }
  }
  const rows = await db.sequelize.query(
    `SELECT c.id, c.workspace_id AS "workspaceId", (w.settings->'loyalty'->>'expiryDays')::int AS days
       FROM customers c JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.loyalty_points > 0 AND w.settings->'loyalty'->>'expiryDays' IS NOT NULL
        AND ${lastActiveSql('c', 'w')} < NOW() - ((w.settings->'loyalty'->>'expiryDays')::int * INTERVAL '1 day')
      LIMIT 5000`,
    { type: db.Sequelize.QueryTypes.SELECT }
  );
  for (const r of rows) {
    await db.sequelize.transaction(async (t) => {
      const c = await db.Customer.findByPk(r.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (c && c.loyaltyPoints > 0) await move(c.id, -c.loyaltyPoints, 'expire', { note: `no activity for ${r.days} days` }, t);
    }).catch((err) => logger.error(`[loyalty] expire ${r.id}: ${err.message}`));
  }
}

// ----------------------------------------------------------------- views --

const txView = (t) => ({ id: t.id, kind: t.kind, points: t.points, balanceAfter: t.balanceAfter, amount: t.amount === null ? null : String(t.amount), currency: t.currency, orderId: t.orderId, note: t.note, createdAt: t.createdAt });

/** A customer's balance and history; `frozen` (loyaltyAccess) while it can't be earned or spent, and then it doesn't expire either. */
async function accountOf(workspace, customer, limit = 50) {
  const s = settingsOf(workspace);
  const frozen = Boolean(await access.frozenReason(workspace.id));
  const history = await db.LoyaltyTransaction.findAll({ where: { customerId: customer.id, }, order: [['createdAt', 'DESC']], limit });
  const expiresAt = s.expiryDays && customer.loyaltyPoints > 0 && !frozen ? new Date(lastActive(workspace, customer) + s.expiryDays * 864e5) : null;
  return {
    balance: customer.loyaltyPoints,
    worth: s.pointValue ? String(customer.loyaltyPoints * s.pointValue) : null,
    currency: workspace.defaultCurrency,
    expiresAt,
    frozen,
    history: history.map(txView),
  };
}

async function adjust(workspaceId, customerId, points, note, req) {
  if (!points) throw new ValidationError([{ field: 'points', message: 'Give a number of points to add or take' }]);
  const customer = await db.Customer.findOne({ where: { id: customerId, workspaceId } });
  if (!customer) throw new NotFoundError('Customer');
  const out = await db.sequelize.transaction((t) => move(customer.id, points, 'adjust', { note, actorUserId: req.user.id }, t));
  await require('../audit/auditService').recordAudit({ workspaceId, actorUserId: req.user.id, action: 'loyalty.adjust', entityType: 'Customer', entityId: customer.id, after: { points: out.applied, balance: out.balance, note }, req });
  return out;
}

module.exports = { settingsOf, move, earnForOrder, reverseEarned, assertCanSpend, spendOnOrder, onRefundProcessed, onOrderCancelled, onOrderReturned, expireInactive, accountOf, adjust, install, txView };
