'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');

/**
 * Locked orders (ORDERS_LOCK_ENABLED, migration 718): the one place that
 * decides whether the merchant may see an order's customer details, and the
 * one way they are hidden. Every merchant path that shows, exports or sends
 * those details asks here (docs/orders-lock.md lists them). The platform
 * console reads orders through its own services and never asks: it always
 * sees everything.
 *
 * An order's customer details (name, phones, email, the address below the
 * governorate, the notes, the checkout answers) are visible when
 *   (a) the store is entitled now: its subscription runs (anything but the
 *       restricted phase of workspaceAccessService.billingLifecycle), or it
 *       pays per order with WALLET_ENABLED off (no fee is charged then);
 *   (b) the order was settled when it reached its confirmed stage
 *       (orders.contact_lock 'unlocked': confirmed while entitled, its fee
 *       paid, or a free order used), or reached it before that column
 *       existed (contact_lock null);
 *   (c) the order never reached its confirmed stage — pending, or cancelled
 *       or rejected before it was confirmed — and the store pays per order
 *       and can pay the fee now (a free order left, or a balance of at least
 *       one fee);
 *   (d) its pay-per-order fee was charged when it was placed (before the
 *       switch) and not given back: wallet_ledger_entries, read when asked.
 * Otherwise it is locked. A funnel add-on placed as its own order (source
 * 'upsell', linked_from_order_id) shares its customer with the order it
 * follows and is locked exactly when that order is.
 *
 * Locked changes nothing stored: the order is written in full and only its
 * presentation hides (MASK, never a missing field). The products, prices,
 * totals, dates, states and the governorate always show. Renewing or topping
 * up opens everything at once, because it is all decided when read.
 *
 * Off (the default), `contextFor` answers 'open' without a query and nothing
 * is hidden or refused.
 */

// The dashboard writes refuse it (core/utils/refusesHidden), so a hidden value is never saved back.
const { HIDDEN: MASK } = require('../../core/utils/refusesHidden');
const PAID_STATES = ['paid', 'partially_paid', 'refunded', 'partially_refunded'];
const PAID_STATES_SQL = `(${PAID_STATES.map((s) => `'${s}'`).join(', ')})`;
// What a hidden record keeps: its own ids and dates, never the customer's details.
const RECORD_KEPT = ['id', 'workspaceId', 'customerId', 'orderId', 'createdAt', 'updatedAt', 'isDefault', 'label'];
// Shown on a locked order's address: the country and the governorate; everything else in it is masked.
const ADDRESS_KEPT = [...RECORD_KEPT, 'country', 'province'];

const OPEN = Object.freeze({ enabled: false, mode: 'open', canPay: true });

function enabled() {
  return env.ordersLock.enabled === true;
}

/**
 * Where the store stands: mode 'open' (nothing is locked), 'pay_per_order'
 * (with canPay, the fee, the balance and the free orders left) or 'lapsed'
 * (its subscription is past its grace day). One subscription read, plus the
 * plan and the wallet on a fee plan.
 */
async function contextFor(workspaceId, { transaction, now = new Date() } = {}) {
  if (!enabled()) return OPEN;
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    attributes: ['id', 'status', 'planId', 'currentPeriodEnd'],
    transaction,
  });
  if (!subscription) return { ...OPEN, enabled: true };
  const wallet = require('../billing/walletService');
  const terms = wallet.enabled() ? await wallet.termsForSubscription(subscription, transaction) : null;
  if (terms) {
    const row = await db.WorkspaceWallet.findOne({
      where: { workspaceId },
      attributes: ['cashBalance', 'freeOrdersUsed', 'freeOrdersGranted'],
      transaction,
    });
    const balance = row ? Number(row.cashBalance) : 0;
    const freeLeft = wallet.freeLeft(row, terms);
    return {
      enabled: true,
      mode: 'pay_per_order',
      fee: terms.fee,
      balance,
      freeLeft,
      canPay: freeLeft > 0 || balance >= terms.fee,
      currency: wallet.WALLET_CURRENCY,
    };
  }
  const { billingLifecycle } = require('../workspaces/workspaceAccessService');
  const lifecycle = billingLifecycle(subscription, now);
  if (lifecycle.phase === 'restricted') return { enabled: true, mode: 'lapsed', canPay: false, since: lifecycle.restrictsAt };
  return { ...OPEN, enabled: true };
}

const isOpenContext = (ctx) => !ctx || !ctx.enabled || ctx.mode === 'open';

/** The order reached its confirmed stage: a COD confirmation, or an online payment that landed. */
function reachedConfirmation(order) {
  if (order.confirmationState === 'confirmed') return true;
  return order.paymentMethod !== 'cod' && PAID_STATES.includes(order.financialState);
}

const isFollowOn = (order) => Boolean(order.linkedFromOrderId) && order.source === 'upsell';

/**
 * The order on its own, without the order it may follow, and without rule
 * (d), which needs the ledger (placingFeePaid).
 */
function ownVisibility(ctx, order) {
  if (isOpenContext(ctx)) return true;
  if (order.contactLock === 'unlocked') return true;
  if (order.contactLock == null && reachedConfirmation(order)) return true;
  // (c) A cancelled or rejected order that was never confirmed counts as pending (Ziad, 2026-10-25).
  if (ctx.mode === 'pay_per_order' && ctx.canPay && !reachedConfirmation(order)) return true;
  return false;
}

// (d) The fee charged when the order was placed — before the switch, by
// walletService.chargeOrderFee — and not given back since: walletService's
// orderFeeState reading (charges, recharges and reversals counted). Nothing
// is written for it (Ziad, 2026-10-25: no backfill).
const PLACING_FEE_TYPES = ['order_fee', 'order_fee_recharge', 'order_fee_reversal'];
const placingFeePaidSql = (a) => `EXISTS (
    SELECT 1 FROM wallet_ledger_entries fe
     WHERE fe.order_id = ${a}.id AND fe.entry_type IN ('order_fee', 'order_fee_recharge', 'order_fee_reversal')
    HAVING COUNT(*) FILTER (WHERE fe.entry_type <> 'order_fee_reversal') > COUNT(*) FILTER (WHERE fe.entry_type = 'order_fee_reversal'))`;

/** The ids among `ids` whose fee was paid when placed (rule (d)): one query, none for an empty list. */
async function placingFeePaid(ids, transaction) {
  if (ids.length === 0) return new Set();
  const rows = await db.sequelize.query(
    `SELECT fe.order_id FROM wallet_ledger_entries fe
      WHERE fe.order_id IN (:ids) AND fe.entry_type IN (:types)
      GROUP BY fe.order_id
     HAVING COUNT(*) FILTER (WHERE fe.entry_type <> 'order_fee_reversal') > COUNT(*) FILTER (WHERE fe.entry_type = 'order_fee_reversal')`,
    { replacements: { ids, types: PLACING_FEE_TYPES }, type: QueryTypes.SELECT, transaction }
  );
  return new Set(rows.map((r) => r.order_id));
}

// What a batch decision needs of each order (and of the orders they follow).
const ORDER_ATTRIBUTES = [
  'id',
  'workspaceId',
  'confirmationState',
  'financialState',
  'paymentMethod',
  'cancelledAt',
  'contactLock',
  'linkedFromOrderId',
  'source',
  'totalAmount',
  'currency',
];

/**
 * The ids of the locked orders among `orders` (instances or plain rows with
 * ORDER_ATTRIBUTES). Loads the orders followed by any add-on in the batch.
 */
async function lockedIds(ctx, orders, { transaction } = {}) {
  const locked = new Set();
  if (isOpenContext(ctx) || orders.length === 0) return locked;
  const parentIds = [...new Set(orders.filter(isFollowOn).map((o) => o.linkedFromOrderId))];
  const parents = parentIds.length
    ? await db.Order.findAll({ where: { id: parentIds, workspaceId: orders[0].workspaceId }, attributes: ORDER_ATTRIBUTES, transaction })
    : [];
  // The ledger is read only for the orders the other rules leave locked.
  const feePaid = await placingFeePaid([...new Set([...orders, ...parents].filter((o) => !ownVisibility(ctx, o)).map((o) => o.id))], transaction);
  const visibleAlone = (o) => ownVisibility(ctx, o) || feePaid.has(o.id);
  const parentVisible = new Map(parents.map((p) => [p.id, visibleAlone(p)]));
  for (const order of orders) {
    const visible = visibleAlone(order) || (isFollowOn(order) && parentVisible.get(order.linkedFromOrderId) === true);
    if (!visible) locked.add(order.id);
  }
  return locked;
}

/** Whether one order is locked for its store right now. */
async function isLocked(order, { ctx, transaction } = {}) {
  const context = ctx || (await contextFor(order.workspaceId, { transaction }));
  return (await lockedIds(context, [order], { transaction })).has(order.id);
}

/**
 * The SQL twin of the rule, for a search that must not match a locked
 * order's customer details: true when the row aliased `alias` is visible.
 * Binds nothing; ctx decides which arms exist.
 */
function visibleSql(ctx, alias = 'o') {
  if (isOpenContext(ctx)) return 'TRUE';
  const own = (a) => {
    const reached = `(${a}.confirmation_state = 'confirmed' OR (${a}.payment_method <> 'cod' AND ${a}.financial_state IN ${PAID_STATES_SQL}))`;
    // COALESCE: a null contact_lock must give false here, never NULL, so NOT (...) still counts the row.
    const arms = [`COALESCE(${a}.contact_lock, '') = 'unlocked'`, `(${a}.contact_lock IS NULL AND ${reached})`];
    if (ctx.mode === 'pay_per_order' && ctx.canPay) arms.push(`(NOT ${reached})`);
    arms.push(placingFeePaidSql(a));
    return `(${arms.join(' OR ')})`;
  };
  return `(${own(alias)} OR (${alias}.linked_from_order_id IS NOT NULL AND ${alias}.source = 'upsell' AND EXISTS (
            SELECT 1 FROM orders lp WHERE lp.id = ${alias}.linked_from_order_id AND ${own('lp')})))`;
}

/**
 * Customers: a customer is hidden when every order they placed with the
 * store is locked (one visible order shows them; a customer with no order —
 * a lead, an import — is not an order's data and shows). The SQL is true
 * when the customer row aliased `alias` is visible.
 */
function customerVisibleSql(ctx, alias = 'c') {
  if (isOpenContext(ctx)) return 'TRUE';
  return `(NOT EXISTS (SELECT 1 FROM orders co WHERE co.customer_id = ${alias}.id AND co.workspace_id = ${alias}.workspace_id)
           OR EXISTS (SELECT 1 FROM orders co WHERE co.customer_id = ${alias}.id AND co.workspace_id = ${alias}.workspace_id AND ${visibleSql(ctx, 'co')}))`;
}

/** The ids of the hidden customers among `customerIds`. */
async function lockedCustomerIds(ctx, workspaceId, customerIds, { transaction } = {}) {
  const ids = [...new Set((customerIds || []).filter(Boolean))];
  if (isOpenContext(ctx) || ids.length === 0) return new Set();
  const rows = await db.sequelize.query(
    `SELECT c.id FROM customers c WHERE c.workspace_id = :workspaceId AND c.id IN (:ids) AND NOT ${customerVisibleSql(ctx, 'c')}`,
    { replacements: { workspaceId, ids }, type: QueryTypes.SELECT, transaction }
  );
  return new Set(rows.map((r) => r.id));
}

// ------------------------------------------------------------- hiding

const masked = (value) => (value === null || value === undefined || value === '' ? value : MASK);

/**
 * Every string in `obj` (nested too) becomes MASK, every number null; keys
 * in `keep`, booleans and dates stay. An empty value stays empty, so the
 * dashboard tells "hidden" from "never given".
 */
function maskObject(obj, keep = []) {
  if (!obj || typeof obj !== 'object' || obj instanceof Date) return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (keep.includes(key) || typeof value === 'boolean' || value instanceof Date) out[key] = value;
    else if (value && typeof value === 'object') out[key] = maskObject(value, keep);
    else if (typeof value === 'number') out[key] = null;
    else out[key] = masked(value);
  }
  return out;
}

const maskContact = (contact) => maskObject(contact);
const maskAddress = (address) => maskObject(address, ADDRESS_KEPT);

/** A row of some other module's view with the named customer fields hidden (a name, a phone, an email). */
function maskFields(row, keys) {
  const out = { ...row };
  for (const key of keys) if (key in out) out[key] = masked(out[key]);
  out.contactLocked = true;
  return out;
}

/** An InstaPay / wallet transfer: the payer's number and the screenshot (which names them). */
const maskManualPayment = (payment) => payment && { ...payment, payerNumber: masked(payment.payerNumber), proofUrl: null, proofUrlExpiresAt: null };

/** A customer row as the merchant would see it, hidden. */
function maskCustomer(customer) {
  if (!customer) return customer;
  const plain = typeof customer.toJSON === 'function' ? customer.toJSON() : { ...customer };
  for (const key of ['fullName', 'phoneRaw', 'phoneNormalized', 'alternatePhone', 'email']) plain[key] = masked(plain[key]);
  if (Array.isArray(plain.savedAddresses)) plain.savedAddresses = plain.savedAddresses.map((a) => maskAddress(a));
  if (Array.isArray(plain.addresses)) plain.addresses = plain.addresses.map((a) => maskAddress(a));
  plain.contactLocked = true;
  return plain;
}

/**
 * A plain order (toJSON or a serializer's object) with its customer details
 * hidden, and `contactLocked: true` with the reason ('subscription' or
 * 'balance') for the dashboard. Everything else is kept as it was.
 */
function maskOrder(order, ctx) {
  const out = { ...order };
  if ('contactSnapshot' in out) out.contactSnapshot = maskContact(out.contactSnapshot);
  if ('shippingAddressSnapshot' in out) out.shippingAddressSnapshot = maskAddress(out.shippingAddressSnapshot);
  if ('notes' in out) out.notes = masked(out.notes);
  if ('checkoutFields' in out) out.checkoutFields = maskObject(out.checkoutFields);
  if (out.giftOptions && typeof out.giftOptions === 'object') out.giftOptions = { ...out.giftOptions, message: masked(out.giftOptions.message) };
  for (const key of ['ipAddress', 'userAgent', 'deviceId']) if (key in out) out[key] = masked(out[key]);
  if (out.customer) out.customer = maskCustomer(out.customer);
  // The shipping card's saved draft carries the receiver: not shown while locked.
  if (out.shipmentDraft) out.shipmentDraft = null;
  if (out.manualPayment) out.manualPayment = maskManualPayment(out.manualPayment);
  out.contactLocked = true;
  out.lockReason = lockReason(ctx);
  return out;
}

const lockReason = (ctx) => (ctx && ctx.mode === 'lapsed' ? 'subscription' : 'balance');

/**
 * The batch presenter every merchant list and detail goes through: plain
 * orders in, the same orders out with the locked ones hidden and every one
 * carrying `contactLocked`. One context read and, for add-ons, one query.
 */
async function presentOrders(workspaceId, orders, { ctx, transaction } = {}) {
  const context = ctx || (await contextFor(workspaceId, { transaction }));
  // Switch off: the answer is exactly what it was, without the new field.
  if (!context.enabled) return orders;
  const locked = await lockedIds(context, orders, { transaction });
  return orders.map((o) => (locked.has(o.id) ? maskOrder(o, context) : { ...o, contactLocked: false }));
}

async function presentOrder(workspaceId, order, opts) {
  const [one] = await presentOrders(workspaceId, [order], opts);
  return one;
}

/**
 * Customers (plain rows or instances, `id` required) with the hidden ones
 * masked and each carrying `contactLocked`. `pick` reads the customer id of
 * a row whose id is not the customer's (a lost order, an RFM row).
 */
async function presentCustomers(workspaceId, rows, { ctx, transaction, pick = (r) => r.id, mask = maskCustomer } = {}) {
  const context = ctx || (await contextFor(workspaceId, { transaction }));
  if (!context.enabled) return rows;
  const locked = await lockedCustomerIds(context, workspaceId, rows.map(pick), { transaction });
  return rows.map((row) => {
    const plain = row && typeof row.toJSON === 'function' ? row.toJSON() : row;
    if (!plain) return plain;
    return locked.has(pick(plain)) ? mask(plain) : { ...plain, contactLocked: false };
  });
}

// ------------------------------------------------------------- refusing

function lockedError(ctx) {
  const lapsed = ctx && ctx.mode === 'lapsed';
  return new AppError(
    'ORDER_LOCKED',
    lapsed
      ? "This order's customer details are hidden until your subscription is renewed. Renew it from Subscription, then try again."
      : "This order's customer details are hidden until your Zimos balance can pay its fee. Top it up from Subscription, then try again.",
    402,
    { reason: lockReason(ctx), ...(ctx && ctx.mode === 'pay_per_order' ? { balance: ctx.balance, fee: ctx.fee, freeLeft: ctx.freeLeft, currency: ctx.currency } : {}) }
  );
}

/**
 * Refuses (402 ORDER_LOCKED) an action that would use or send a locked
 * order's customer details: booking a courier, a message to the customer, a
 * document with their address. `order` needs ORDER_ATTRIBUTES; pass an id to
 * have it loaded.
 */
async function assertUnlocked(workspaceId, orderOrId, { transaction } = {}) {
  if (!enabled()) return;
  const ctx = await contextFor(workspaceId, { transaction });
  if (isOpenContext(ctx)) return;
  const order =
    typeof orderOrId === 'string'
      ? await db.Order.findOne({ where: { id: orderOrId, workspaceId }, attributes: ORDER_ATTRIBUTES, transaction })
      : orderOrId;
  if (!order) return;
  if ((await lockedIds(ctx, [order], { transaction })).has(order.id)) throw lockedError(ctx);
}

/** Whether this store's order `orderId` is locked now (false when there is no such order). */
async function isOrderLocked(workspaceId, orderId, { transaction } = {}) {
  if (!enabled() || !orderId) return false;
  const ctx = await contextFor(workspaceId, { transaction });
  if (isOpenContext(ctx)) return false;
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ORDER_ATTRIBUTES, transaction });
  return Boolean(order) && (await lockedIds(ctx, [order], { transaction })).has(order.id);
}

/**
 * Refuses (402 ORDER_LOCKED) a merchant action on a customer who comes
 * hidden: the merchant would write over, or learn, details they cannot see.
 */
async function assertCustomerVisible(workspaceId, customerId) {
  if (!enabled()) return;
  const ctx = await contextFor(workspaceId);
  if ((await lockedCustomerIds(ctx, workspaceId, [customerId])).size > 0) throw lockedError(ctx);
}

/**
 * For a job about to message a customer or a third party about an order:
 * true when it must not (the order is locked). Never throws.
 */
async function mustNotSend(workspaceId, orderId) {
  if (!enabled() || !orderId) return false;
  try {
    await assertUnlocked(workspaceId, orderId);
    return false;
  } catch (err) {
    return err && err.code === 'ORDER_LOCKED';
  }
}

/**
 * Whether what is not an order yet — an open unconfirmed order, a lost
 * checkout (checkoutSessions) — is hidden for this store now: rule (c) alone.
 */
function pendingLocked(ctx) {
  if (isOpenContext(ctx)) return false;
  return !(ctx.mode === 'pay_per_order' && ctx.canPay);
}

/** 402 ORDER_LOCKED for an action on a lost checkout while pendingLocked (reveal, message, convert). */
async function assertPendingOpen(workspaceId) {
  if (!enabled()) return;
  const ctx = await contextFor(workspaceId);
  if (pendingLocked(ctx)) throw lockedError(ctx);
}

/** A lost checkout as GET /checkout-sessions serializes it, hidden; the recovery link opens it, so it goes too. */
function maskLostOrder(session) {
  return {
    ...session,
    customerName: masked(session.customerName),
    phone: masked(session.phone),
    email: masked(session.email),
    shippingAddress: maskAddress(session.shippingAddress),
    ipAddress: masked(session.ipAddress),
    recoveryPath: null,
    contactLocked: true,
  };
}

/**
 * For an automation about to run a step that carries the customer's details
 * (a message, a webhook, a note to the team): true when its subject is
 * locked. Orders by the rule; a lost checkout by pendingLocked; a lead
 * (no order) never.
 */
async function subjectLocked(workspaceId, subject) {
  if (!enabled() || !subject) return false;
  if (subject.kind === 'order' && subject.order) return mustNotSend(workspaceId, subject.order.id);
  if (subject.kind === 'checkout') return pendingLocked(await contextFor(workspaceId));
  return false;
}

// ------------------------------------------------------------- summary

/**
 * GET /workspaces/:id/orders/locked-summary — what the dashboard's banner
 * says: how many open orders are locked and what they are worth (per
 * currency), and the store's standing. Closed orders are not counted. A
 * 'due' order paid online counts while the store cannot pay (it is visible
 * once its fee is taken).
 */
async function lockedSummary(workspaceId) {
  const ctx = await contextFor(workspaceId);
  const base = {
    enabled: ctx.enabled,
    mode: ctx.mode,
    reason: isOpenContext(ctx) ? null : lockReason(ctx),
    canPay: ctx.canPay !== false,
    ...(ctx.mode === 'pay_per_order' ? { fee: ctx.fee, balance: ctx.balance, freeLeft: ctx.freeLeft, currency: ctx.currency } : {}),
  };
  if (isOpenContext(ctx)) return { ...base, count: 0, due: 0, totals: [] };
  // `due`: paid online with the fee still owed — settled by POST /orders/locked/settle once it can pay.
  const rows = await db.sequelize.query(
    `SELECT o.currency, COUNT(*)::int AS count, COALESCE(SUM(o.total_amount), 0)::bigint AS amount,
            COUNT(*) FILTER (WHERE o.contact_lock = 'due')::int AS due
       FROM orders o
      WHERE o.workspace_id = $workspaceId
        AND o.cancelled_at IS NULL AND o.confirmation_state <> 'rejected'
        AND NOT ${visibleSql(ctx, 'o')}
      GROUP BY o.currency
      ORDER BY 2 DESC`,
    { bind: { workspaceId }, type: QueryTypes.SELECT }
  );
  return {
    ...base,
    count: rows.reduce((n, r) => n + r.count, 0),
    due: rows.reduce((n, r) => n + r.due, 0),
    totals: rows.map((r) => ({ currency: r.currency, amount: Number(r.amount), count: r.count })),
  };
}

module.exports = {
  MASK,
  ORDER_ATTRIBUTES,
  enabled,
  contextFor,
  isOpenContext,
  reachedConfirmation,
  isFollowOn,
  lockedIds,
  isLocked,
  visibleSql,
  customerVisibleSql,
  lockedCustomerIds,
  presentCustomers,
  maskObject,
  maskOrder,
  maskContact,
  maskAddress,
  maskCustomer,
  maskFields,
  maskManualPayment,
  presentOrders,
  presentOrder,
  lockedError,
  assertUnlocked,
  isOrderLocked,
  assertCustomerVisible,
  mustNotSend,
  pendingLocked,
  assertPendingOpen,
  maskLostOrder,
  subjectLocked,
  lockedSummary,
};
