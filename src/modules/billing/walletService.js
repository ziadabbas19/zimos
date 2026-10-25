'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const shipmentLifecycle = require('../orders/shipmentLifecycle');

/**
 * The prepaid balance behind the pay-per-order plan (migration 131). All of
 * it waits on WALLET_ENABLED: off, no fee is charged, no plan with a fee is
 * offered and no top-up is taken — as before it existed. A fee charged while
 * it was on is still given back when its order is cancelled after it goes
 * off (`reverseOrderFee` reads the order's own ledger rows, nothing else).
 *
 * Every change is one row in wallet_ledger_entries (append-only) and the
 * cached balance on workspace_wallets, in one transaction:
 *   1. INSERT the wallet row ON CONFLICT DO NOTHING, then lock it FOR UPDATE —
 *      always the LAST lock its transaction takes, so nothing holding the
 *      wallet waits on another row (no deadlock with the order and stock
 *      locks taken before it);
 *   2. read what already happened from the ledger, under that lock;
 *   3. write the entry with its idempotency key, and the cache.
 *
 * An order's fee: charged once when the order is created, while the store's
 * subscription is active on a plan whose per_order_fee_amount > 0, and
 * refused when the balance would go below -OVERDRAFT_LIMIT. Given back when
 * the order is cancelled, rejected, expires unpaid or is cancelled for a
 * blocklisted customer; charged again (order_fee_recharge, past the
 * overdraft — the order exists already) when a rejection is corrected to
 * confirmed or a late payment reopens it. Never after a parcel has shipped.
 * The keys — order_fee:<order>:<n>, order_fee_reversal:<order>:<n>,
 * order_fee_recharge:<order>:<n> — and the state read from the order's own
 * entries make a repeated event change nothing, and charge → give back →
 * charge again work.
 *
 * Per plan (migration 220), every default keeping the above:
 *   wallet_free_orders        orders placed free before any fee: an order_fee
 *                             entry with cash 0 and free_orders_delta -1,
 *                             given back and taken again like a fee. The
 *                             console grants more per store
 *                             (free_orders_grant:<requestId>).
 *   wallet_debt_limit_amount  null: the fixed OVERDRAFT_LIMIT and the old
 *                             refusal (402 staff, 423 and a restricted store
 *                             for shoppers). Set: that limit, past it 422
 *                             WALLET_LIMIT_REACHED with the store still open,
 *                             and the team is told in the bell when the
 *                             balance runs low and when the limit is reached.
 * The console also corrects a balance by hand, with a reason
 * (adjustment:<requestId>). A top-up clears a debt first because the balance
 * is one signed number.
 */

const WALLET_CURRENCY = 'EGP';
// Named limits (minor units). Changing one is a code change, on purpose.
const MIN_TOPUP_AMOUNT = 10000; // EGP 100
const MAX_TOPUP_AMOUNT = 2000000; // EGP 20,000
const OVERDRAFT_LIMIT = 1000; // EGP 10 below zero
const MAX_OPEN_TOPUPS = 3;
// The dashboard warns below this many orders left (Q18).
const LOW_BALANCE_ORDERS = 20;

const FEE_TYPES = ['order_fee', 'order_fee_recharge'];
// A console correction of a balance, either way (minor units).
const MAX_ADJUSTMENT = 2000000; // EGP 20,000
const MAX_FREE_ORDERS_GRANT = 1000;

function enabled() {
  return env.wallet.enabled === true;
}

// ORDERS_LOCK_ENABLED (orders/orderLock.js): the fee moves to the confirmation.
const ordersLockOn = () => env.ordersLock.enabled === true;

function disabledError() {
  return new AppError('WALLET_DISABLED', 'The prepaid balance is not available.', 404);
}

/** The fee the store's next order costs, or null when it pays none. */
async function feeDue(workspaceId, transaction) {
  const subscription = await db.Subscription.findOne({
    where: { workspaceId },
    attributes: ['id', 'status', 'planId'],
    transaction,
  });
  return feeForSubscription(subscription, transaction);
}

async function feeForSubscription(subscription, transaction) {
  const terms = await termsForSubscription(subscription, transaction);
  return terms ? terms.fee : null;
}

/**
 * A plan's wallet terms: the fee, its free orders and how far below zero the
 * balance may go. `policy` 'overdraft' is the fixed OVERDRAFT_LIMIT and the
 * old refusal; 'debt_limit' is the plan's own limit (422).
 */
function termsOf(plan) {
  const debtLimit = plan.walletDebtLimitAmount === null || plan.walletDebtLimitAmount === undefined ? null : Number(plan.walletDebtLimitAmount);
  return {
    fee: Number(plan.perOrderFeeAmount),
    freeOrders: Number(plan.walletFreeOrders || 0),
    debtLimit,
    limit: debtLimit === null ? OVERDRAFT_LIMIT : debtLimit,
    policy: debtLimit === null ? 'overdraft' : 'debt_limit',
  };
}

/** The terms of the store's plan while it pays a fee per order (active, fee > 0), else null. */
async function termsForSubscription(subscription, transaction) {
  if (!subscription || subscription.status !== 'active' || !subscription.planId) return null;
  const plan = await db.Plan.findByPk(subscription.planId, {
    attributes: ['id', 'perOrderFeeAmount', 'walletFreeOrders', 'walletDebtLimitAmount'],
    transaction,
  });
  return plan && Number(plan.perOrderFeeAmount) > 0 ? termsOf(plan) : null;
}

async function termsDue(workspaceId, transaction) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, attributes: ['id', 'status', 'planId'], transaction });
  return termsForSubscription(subscription, transaction);
}

/** Free orders still to use: the plan's, plus the console's grants, less those used. */
function freeLeft(wallet, terms) {
  if (!terms) return 0;
  const granted = wallet ? Number(wallet.freeOrdersGranted || 0) : 0;
  const used = wallet ? Number(wallet.freeOrdersUsed || 0) : 0;
  return Math.max(0, terms.freeOrders + granted - used);
}

/** The store's wallet row, made if missing, locked. The last lock of its transaction. */
async function lockWallet(workspaceId, transaction) {
  await db.sequelize.query(
    `INSERT INTO workspace_wallets (id, workspace_id, currency, cash_balance, total_topped_up, created_at, updated_at)
     VALUES ($id, $workspaceId, $currency, 0, 0, NOW(), NOW())
     ON CONFLICT (workspace_id) DO NOTHING`,
    { bind: { id: crypto.randomUUID(), workspaceId, currency: WALLET_CURRENCY }, transaction }
  );
  return db.WorkspaceWallet.findOne({ where: { workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
}

/** What the order's own ledger rows say: charged now or not, and how often each happened. */
async function orderFeeState(orderId, transaction) {
  const rows = await db.WalletLedgerEntry.findAll({
    where: { orderId },
    attributes: ['entryType', 'cashDelta', 'freeOrdersDelta'],
    order: [['createdAt', 'ASC']],
    transaction,
  });
  const state = { charges: 0, fees: 0, recharges: 0, reversals: 0, lastCharge: 0, lastFree: false };
  for (const row of rows) {
    if (FEE_TYPES.includes(row.entryType)) {
      state.charges += 1;
      state.lastCharge = -Number(row.cashDelta);
      state.lastFree = Number(row.freeOrdersDelta) < 0;
      if (row.entryType === 'order_fee') state.fees += 1;
      else state.recharges += 1;
    } else if (row.entryType === 'order_fee_reversal') {
      state.reversals += 1;
    }
  }
  state.charged = state.charges > state.reversals;
  return state;
}

async function writeEntry(
  wallet,
  { type, delta, freeDelta = 0, orderId = null, paymentProofId = null, refundRequestId = null, actorUserId = null, note = null, key },
  transaction
) {
  const balanceAfter = Number(wallet.cashBalance) + delta;
  const entry = await db.WalletLedgerEntry.create(
    {
      workspaceId: wallet.workspaceId,
      entryType: type,
      cashDelta: delta,
      freeOrdersDelta: freeDelta,
      refundRequestId,
      balanceAfter,
      currency: wallet.currency,
      orderId,
      paymentProofId,
      actorUserId,
      note,
      idempotencyKey: key,
    },
    { transaction }
  );
  await wallet.update(
    {
      cashBalance: balanceAfter,
      ...(type === 'topup' ? { totalToppedUp: Number(wallet.totalToppedUp) + delta } : {}),
      // A grant adds to what the console gave; an order entry takes (or gives back) one.
      ...(freeDelta && type === 'free_orders_grant' ? { freeOrdersGranted: Number(wallet.freeOrdersGranted) + freeDelta } : {}),
      ...(freeDelta && type !== 'free_orders_grant' ? { freeOrdersUsed: Number(wallet.freeOrdersUsed) - freeDelta } : {}),
    },
    { transaction }
  );
  // More to pay with (a top-up, a gift, a fee given back, free orders granted):
  // orders paid online while their fee could not be paid are settled once this
  // commits (confirmFeeService.settleDue; only with ORDERS_LOCK_ENABLED).
  if (ordersLockOn() && (delta > 0 || (type === 'free_orders_grant' && freeDelta > 0))) {
    require('./confirmFeeService').settleDueAfterCommit(transaction, wallet.workspaceId);
  }
  return entry;
}

/** A parcel of this order has left (the same rule as orders/shipmentLifecycle.assertNotShipped). */
async function hasShipped(order, transaction) {
  if (['fulfilled', 'partially_fulfilled', 'returned'].includes(order.fulfillmentState)) return true;
  return (await db.Shipment.count({ where: { orderId: order.id, status: shipmentLifecycle.SHIPMENT_IN_MOTION }, transaction })) > 0;
}

async function balanceRefusal(workspaceId, { staff, balance, fee, terms }) {
  if (terms && terms.policy === 'debt_limit') {
    // The plan's own limit: the store stays open, only new orders wait for a top-up.
    return new AppError(
      'WALLET_LIMIT_REACHED',
      staff
        ? 'Your Zimos balance has reached its limit, so no new order can be taken. Top it up from Subscription, then try again.'
        : 'This store cannot take new orders right now. Please try again later.',
      422,
      staff ? { balance, fee, limit: terms.limit, currency: WALLET_CURRENCY } : undefined
    );
  }
  if (staff) {
    return new AppError(
      'WALLET_BALANCE_TOO_LOW',
      'Your Zimos balance is too low to take another order. Top it up from Subscription, then try again.',
      402,
      { balance, fee, overdraft: OVERDRAFT_LIMIT, currency: WALLET_CURRENCY }
    );
  }
  // A shopper sees what a restricted store shows (core/middleware/publicWorkspace).
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name', 'slug', 'defaultLocale', 'logoUrl'] });
  return new AppError('STORE_UNAVAILABLE', 'This store is currently unavailable.', 423, {
    store: workspace
      ? { name: workspace.name, slug: workspace.slug, defaultLocale: workspace.defaultLocale, logoUrl: workspace.logoUrl }
      : null,
  });
}

/**
 * Inside createOrder, after Order.create, as its transaction's last lock.
 * `staff`: the order is placed in the dashboard (402), otherwise by a shopper
 * (423, as a restricted store answers). Resolves the entry, or null.
 */
async function chargeOrderFee(order, { staff = false } = {}, transaction) {
  if (!enabled()) return null;
  // Locked orders on: the fee is taken when the order is confirmed instead
  // (confirmFeeService), and placing an order is never refused for it.
  if (ordersLockOn()) return null;
  const terms = await termsDue(order.workspaceId, transaction);
  if (!terms) return null;
  const { fee } = terms;
  const wallet = await lockWallet(order.workspaceId, transaction);
  const state = await orderFeeState(order.id, transaction);
  if (state.charged) return null;
  const key = `order_fee:${order.id}:${state.fees + 1}`;
  // Free orders go first: no money moves, and the entry still names the order.
  if (freeLeft(wallet, terms) > 0) {
    const entry = await writeEntry(wallet, { type: 'order_fee', delta: 0, freeDelta: -1, orderId: order.id, note: 'Free order', key }, transaction);
    tellAfterCommit(transaction, order.workspaceId, describeWallet(wallet, terms), terms);
    return entry;
  }
  const balance = Number(wallet.cashBalance);
  if (balance - fee < -terms.limit) {
    if (terms.policy === 'debt_limit') await tell(order.workspaceId, describeWallet(wallet, terms));
    throw await balanceRefusal(order.workspaceId, { staff, balance, fee, terms });
  }
  const entry = await writeEntry(wallet, { type: 'order_fee', delta: -fee, orderId: order.id, key }, transaction);
  tellAfterCommit(transaction, order.workspaceId, describeWallet(wallet, terms), terms);
  return entry;
}

// ------------------------------------------------- the team, in the bell

/**
 * On a plan with its own debt limit only: the bell says the balance is low
 * (or below zero), or that the limit is reached. At most once a day each
 * (the notification's dedupe key). merchantNotificationService logs its own
 * failures and never throws.
 */
async function tell(workspaceId, described) {
  const events = require('../notifications/merchantNotificationEvents');
  if (described.phase === 'exhausted') return events.walletLimitReached(workspaceId, described);
  if (described.phase === 'low' || described.phase === 'overdraft') return events.walletLow(workspaceId, described);
  return null;
}

function tellAfterCommit(transaction, workspaceId, described, terms) {
  if (terms.policy !== 'debt_limit' || described.phase === 'ok') return;
  transaction.afterCommit(() => tell(workspaceId, described).catch(() => {}));
}

/**
 * The fee given back: the order was cancelled, rejected, expired unpaid or
 * cancelled for a blocklisted customer. Not tied to WALLET_ENABLED, and a
 * no-op for an order with no fee on it now or one that has shipped.
 */
async function reverseOrderFee(order, { reason = null, actorUserId = null } = {}, transaction) {
  // Locked orders on: a fee is never given back once its order was confirmed
  // (`order` as it stood before this change). A fee taken at placing, before
  // the switch, for an order never confirmed still is.
  if (ordersLockOn() && (order.contactLock === 'unlocked' || require('../orders/orderLock').reachedConfirmation(order))) return null;
  const touched = await db.WalletLedgerEntry.count({ where: { orderId: order.id }, transaction });
  if (!touched || (await hasShipped(order, transaction))) return null;
  const wallet = await lockWallet(order.workspaceId, transaction);
  const state = await orderFeeState(order.id, transaction);
  if (!state.charged) return null;
  return writeEntry(
    wallet,
    {
      type: 'order_fee_reversal',
      delta: state.lastCharge,
      // A free order given back is free to use again.
      freeDelta: state.lastFree ? 1 : 0,
      orderId: order.id,
      actorUserId,
      note: reason,
      key: `order_fee_reversal:${order.id}:${state.reversals + 1}`,
    },
    transaction
  );
}

/**
 * The fee charged again for an order that comes back (a rejection corrected
 * to confirmed, a late payment reopening it): only one whose fee was given
 * back, at the amount it was charged, even past the overdraft (Q16).
 */
async function rechargeOrderFee(order, { actorUserId = null } = {}, transaction) {
  if (!enabled()) return null;
  // Locked orders on: confirming the order again takes its confirmation fee
  // (once ever), so nothing is charged again here.
  if (ordersLockOn()) return null;
  const touched = await db.WalletLedgerEntry.count({ where: { orderId: order.id }, transaction });
  if (!touched || (await hasShipped(order, transaction))) return null;
  const wallet = await lockWallet(order.workspaceId, transaction);
  const state = await orderFeeState(order.id, transaction);
  if (state.charged || state.charges === 0) return null;
  return writeEntry(
    wallet,
    {
      type: 'order_fee_recharge',
      delta: -state.lastCharge,
      // As it was charged: a free order takes a free order again.
      freeDelta: state.lastFree ? -1 : 0,
      orderId: order.id,
      actorUserId,
      key: `order_fee_recharge:${order.id}:${state.recharges + 1}`,
    },
    transaction
  );
}

/** A top-up approved in the console: once per proof (topup:<proofId>), by what arrived. */
async function creditTopup(proof, receivedAmount, actorUserId, transaction) {
  const wallet = await lockWallet(proof.workspaceId, transaction);
  const key = `topup:${proof.id}`;
  if (await db.WalletLedgerEntry.count({ where: { idempotencyKey: key }, transaction })) return null;
  return writeEntry(
    wallet,
    { type: 'topup', delta: receivedAmount, paymentProofId: proof.id, actorUserId, note: `Transfer (${proof.methodCode})`, key },
    transaction
  );
}

/**
 * A card top-up the gateway's own API confirmed (onlineBillingService), once
 * per attempt (topup:attempt:<id>). Not tied to WALLET_ENABLED: money that
 * arrived is credited.
 */
async function creditGatewayTopup(attempt, amount, transaction) {
  const wallet = await lockWallet(attempt.workspaceId, transaction);
  const key = `topup:attempt:${attempt.id}`;
  if (await db.WalletLedgerEntry.count({ where: { idempotencyKey: key }, transaction })) return null;
  return writeEntry(wallet, { type: 'topup', delta: amount, note: `Card (${attempt.provider})`, key }, transaction);
}

// ------------------------------------------------------------- reading

/**
 * Where a balance stands against the fee: ok, low (fewer than
 * LOW_BALANCE_ORDERS orders left before the overdraft), overdraft (at or
 * below zero) or exhausted (the next order is refused). Q18.
 */
function describe(balance, fee, { limit = OVERDRAFT_LIMIT, free = 0, policy = 'overdraft' } = {}) {
  // Free orders still to use count as orders left and hold off the overdraft phases.
  const ordersLeft = fee ? free + Math.max(0, Math.floor((balance + limit) / fee)) : null;
  const ordersBeforeOverdraft = fee ? free + Math.max(0, Math.floor(balance / fee)) : null;
  let phase = 'ok';
  if (fee && free === 0 && balance - fee < -limit) phase = 'exhausted';
  else if (fee && free === 0 && balance <= 0) phase = 'overdraft';
  else if (fee && ordersBeforeOverdraft < LOW_BALANCE_ORDERS) phase = 'low';
  return {
    phase,
    balance,
    fee,
    ordersLeft,
    ordersBeforeOverdraft,
    overdraft: limit,
    debt: Math.max(0, -balance),
    freeOrdersLeft: free,
    policy,
    currency: WALLET_CURRENCY,
  };
}

/** describe() for a wallet row (or none yet) on a plan's terms. */
function describeWallet(wallet, terms) {
  const balance = wallet ? Number(wallet.cashBalance) : 0;
  return describe(balance, terms.fee, { limit: terms.limit, free: freeLeft(wallet, terms), policy: terms.policy });
}

/**
 * For workspaceAccessService: the wallet line of a store on a fee plan while
 * WALLET_ENABLED is on, else null. Two indexed reads.
 */
async function accessState(workspaceId, subscription) {
  if (!enabled()) return null;
  const terms = await termsForSubscription(subscription);
  if (!terms) return null;
  const wallet = await db.WorkspaceWallet.findOne({
    where: { workspaceId },
    attributes: ['cashBalance', 'freeOrdersUsed', 'freeOrdersGranted'],
  });
  return describeWallet(wallet, terms);
}

/** This calendar month in Cairo: fees charged, net of those given back, and the orders behind them. */
async function monthUsage(workspaceId) {
  const [row] = await db.sequelize.query(
    `SELECT COALESCE(SUM(-cash_delta), 0)::bigint AS spent,
            COUNT(*) FILTER (WHERE entry_type IN ('order_fee', 'order_fee_recharge', 'order_confirm_fee'))::int AS charged,
            COUNT(*) FILTER (WHERE entry_type = 'order_fee_reversal')::int AS reversed
       FROM wallet_ledger_entries
      WHERE workspace_id = $workspaceId
        AND entry_type IN ('order_fee', 'order_fee_reversal', 'order_fee_recharge', 'order_confirm_fee')
        AND created_at >= (date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')`,
    { bind: { workspaceId }, type: QueryTypes.SELECT }
  );
  return { fees: Number(row.spent), orders: Math.max(0, row.charged - row.reversed), timeZone: 'Africa/Cairo' };
}

/** GET /workspaces/:id/billing/wallet — the Usage tab's balance. */
async function summary(workspaceId) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, attributes: ['id', 'status', 'planId'] });
  const [terms, wallet] = await Promise.all([
    termsForSubscription(subscription),
    db.WorkspaceWallet.findOne({ where: { workspaceId } }),
  ]);
  const balance = wallet ? Number(wallet.cashBalance) : 0;
  return {
    enabled: enabled(),
    ...(terms ? describeWallet(wallet, terms) : describe(balance, null)),
    onFeePlan: Boolean(terms),
    // The plan's free orders plus the console's grants, and how many were used.
    freeOrders: {
      allowance: terms ? terms.freeOrders : 0,
      granted: wallet ? Number(wallet.freeOrdersGranted) : 0,
      used: wallet ? Number(wallet.freeOrdersUsed) : 0,
      left: freeLeft(wallet, terms),
    },
    debtLimit: terms ? terms.debtLimit : null,
    // A wallet row exists (something was ever written): the dashboard keeps
    // showing the balance to a store that left the plan.
    hasEntries: Boolean(wallet),
    totalToppedUp: wallet ? Number(wallet.totalToppedUp) : 0,
    month: await monthUsage(workspaceId),
    limits: { minTopup: MIN_TOPUP_AMOUNT, maxTopup: MAX_TOPUP_AMOUNT, maxOpenTopups: MAX_OPEN_TOPUPS, lowOrders: LOW_BALANCE_ORDERS },
  };
}

function serializeEntry(entry) {
  return {
    id: entry.id,
    type: entry.entryType,
    amount: Number(entry.cashDelta),
    freeOrders: Number(entry.freeOrdersDelta || 0),
    balanceAfter: Number(entry.balanceAfter),
    currency: entry.currency,
    orderId: entry.orderId,
    paymentProofId: entry.paymentProofId,
    refundRequestId: entry.refundRequestId || null,
    note: entry.note,
    createdAt: entry.createdAt,
  };
}

/** The ledger, newest first, a page at a time. */
async function ledger(workspaceId, { page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(1, pageSize), 50);
  const { rows, count } = await db.WalletLedgerEntry.findAndCountAll({
    where: { workspaceId },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: size,
    offset: (Math.max(1, page) - 1) * size,
  });
  // The order numbers, for the merchant to recognise them.
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter(Boolean))];
  const orders = orderIds.length
    ? await db.Order.findAll({ where: { id: orderIds, workspaceId }, attributes: ['id', 'orderNumber'] })
    : [];
  const numbers = new Map(orders.map((o) => [o.id, o.orderNumber]));
  return {
    entries: rows.map((r) => ({ ...serializeEntry(r), orderNumber: r.orderId ? numbers.get(r.orderId) || null : null })),
    page: Math.max(1, page),
    pageSize: size,
    total: count,
  };
}

// ------------------------------------------------------------ console

/**
 * One console entry for a store, once per requestId (the console makes one
 * per dialog, so a double click or a retry writes nothing twice), audited
 * with its reason. Resolves { entry, replayed }.
 */
async function consoleEntry(workspaceId, { type, key, write, audit }, req) {
  if (!enabled()) throw disabledError();
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id'], transaction });
    if (!workspace) throw new NotFoundError('Workspace');
    const wallet = await lockWallet(workspaceId, transaction);
    const existing = await db.WalletLedgerEntry.findOne({ where: { idempotencyKey: key }, transaction });
    if (existing) {
      if (existing.workspaceId !== workspaceId) {
        throw new ConflictError('This request id was already used for another store.', 'REQUEST_ID_REUSED');
      }
      return { entry: serializeEntry(existing), replayed: true };
    }
    const before = { balance: Number(wallet.cashBalance), freeOrdersGranted: Number(wallet.freeOrdersGranted) };
    const entry = await writeEntry(wallet, { ...write, type, actorUserId: req.user.id, key }, transaction);
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: audit,
      entityType: 'WorkspaceWallet',
      entityId: wallet.id,
      before,
      after: { balance: Number(wallet.cashBalance), freeOrdersGranted: Number(wallet.freeOrdersGranted) },
      metadata: { ledgerEntryId: entry.id, amount: Number(entry.cashDelta), freeOrders: Number(entry.freeOrdersDelta), reason: entry.note },
      req,
      transaction,
    });
    return { entry: serializeEntry(entry), replayed: false };
  });
}

/** POST /admin/workspaces/:id/wallet/free-orders { count, reason, requestId } — more free orders for one store. */
async function grantFreeOrders(workspaceId, { count, reason, requestId }, req) {
  return consoleEntry(
    workspaceId,
    { type: 'free_orders_grant', key: `free_orders_grant:${requestId}`, write: { delta: 0, freeDelta: count, note: reason }, audit: 'wallet.free_orders_grant' },
    req
  );
}

/**
 * POST /admin/workspaces/:id/wallet/adjustments { amount, reason, requestId,
 * kind, notifyMerchant } — a correction by hand, either way (kind
 * 'correction', the default), or a gift that only adds (kind 'gift').
 * Neither is ever refundable. The store is told only with notifyMerchant.
 */
async function adjustBalance(workspaceId, { amount, reason, requestId, kind = 'correction', notifyMerchant = false }, req) {
  // A gift (migration 223) only adds, and is never refundable: it isn't a top-up.
  const gift = kind === 'gift';
  if (gift && !(amount > 0)) throw new AppError('GIFT_MUST_ADD', 'A gift adds to the balance. Use a correction to take from it.', 422);
  const type = gift ? 'gift' : 'adjustment';
  const result = await consoleEntry(
    workspaceId,
    { type, key: `${type}:${requestId}`, write: { delta: amount, note: reason }, audit: gift ? 'wallet.gift' : 'wallet.adjust' },
    req
  );
  // Told in the bell only when the console asks, and only the first time.
  if (notifyMerchant && !result.replayed) {
    await require('../notifications/merchantNotificationEvents').walletCredit(workspaceId, {
      entryId: result.entry.id,
      amount,
      currency: WALLET_CURRENCY,
      kind: gift ? 'gift' : 'correction',
      reason,
    });
  }
  return result;
}

// ------------------------------------------------------- pay-per-order plan

/** The pay-per-order plan merchants may choose: public, active, a fee and nothing monthly. */
async function offeredFeePlan(transaction) {
  return db.Plan.findOne({
    where: {
      isPublic: true,
      isActive: true,
      currency: WALLET_CURRENCY,
      monthlyPriceAmount: 0,
      perOrderFeeAmount: { [db.Sequelize.Op.gt]: 0 },
    },
    order: [
      ['perOrderFeeAmount', 'ASC'],
      ['displayOrder', 'ASC'],
    ],
    transaction,
  });
}

// A free plan runs this long (goLiveService does the same).
const FEE_PLAN_YEARS = 100;

/**
 * Puts the subscription (held locked by the caller) on the pay-per-order
 * `plan` from `now`: active, no period to pay, fees from the next order.
 * Choosing pay per order uses the account's free trial (none later, on a
 * move to a monthly plan or on another store). Used by choosePayPerOrder and
 * by a plan switch to pay per order (planSwitchService).
 */
async function startPayPerOrder(subscription, plan, { now = new Date(), settleDue = true } = {}, transaction) {
  const workspace = await db.Workspace.findByPk(subscription.workspaceId, { attributes: ['id', 'ownerUserId'], transaction });
  if (workspace && workspace.ownerUserId) {
    await require('./goLiveService').recordTrial(
      { userId: workspace.ownerUserId, planId: plan.id, workspaceId: subscription.workspaceId, source: 'pay_per_order', startedAt: now },
      transaction
    );
  }
  const end = new Date(now);
  end.setUTCFullYear(end.getUTCFullYear() + FEE_PLAN_YEARS);
  await subscription.update(
    { planId: plan.id, status: 'active', trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: end, graceUntil: null, cancelAtPeriodEnd: false },
    { transaction }
  );
  // The orders left 'due' (orders/orderLock) take their fees from the balance once this commits.
  // Not from a scheduled switch (settleDue false): no scheduled job moves the balance's money.
  if (settleDue) require('./confirmFeeService').settleDueAfterCommit(transaction, subscription.workspaceId);
}

/**
 * POST /workspaces/:id/billing/pay-per-order — a draft or a trial moves to
 * the pay-per-order plan at once: active, no period to pay, fees from the
 * next order. A paid subscription changes plan through support, as for any
 * plan change (409 PLAN_CHANGE_NEEDS_SUPPORT); an open charge must be
 * settled first (409 OPEN_CHARGE_EXISTS).
 */
async function choosePayPerOrder(workspaceId, req) {
  if (!enabled()) throw disabledError();
  return db.sequelize.transaction(async (transaction) => {
    const plan = await offeredFeePlan(transaction);
    if (!plan) throw new NotFoundError('Pay-per-order plan');
    const subscription = await db.Subscription.findOne({ where: { workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!subscription) throw new NotFoundError('Subscription');
    if (subscription.planId === plan.id && subscription.status === 'active') return { changed: false };
    if (!['draft', 'trialing'].includes(subscription.status)) {
      throw new ConflictError(
        'Your plan can be changed through Zimos support while a paid subscription runs. Contact support.',
        'PLAN_CHANGE_NEEDS_SUPPORT'
      );
    }
    const open = await db.BillingInvoice.findOne({
      where: { subscriptionId: subscription.id, status: 'pending' },
      attributes: ['id'],
      transaction,
    });
    if (open) throw new ConflictError('A charge is open for the current plan. Settle it before changing plan.', 'OPEN_CHARGE_EXISTS');

    const before = { planId: subscription.planId, status: subscription.status };
    await startPayPerOrder(subscription, plan, { now: new Date() }, transaction);
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'subscription.pay_per_order',
      entityType: 'Subscription',
      entityId: subscription.id,
      before,
      after: { planId: plan.id, status: 'active', fee: Number(plan.perOrderFeeAmount) },
      req,
      transaction,
    });
    return { changed: true };
  });
}

module.exports = {
  WALLET_CURRENCY,
  MIN_TOPUP_AMOUNT,
  MAX_TOPUP_AMOUNT,
  OVERDRAFT_LIMIT,
  MAX_OPEN_TOPUPS,
  LOW_BALANCE_ORDERS,
  MAX_ADJUSTMENT,
  MAX_FREE_ORDERS_GRANT,
  enabled,
  disabledError,
  // For walletRefundService: the wallet row locked (the last lock), and one entry written with its cache.
  lockWallet,
  writeEntry,
  feeDue,
  termsDue,
  termsOf,
  // For orders/orderLock and confirmFeeService (ORDERS_LOCK_ENABLED).
  termsForSubscription,
  freeLeft,
  chargeOrderFee,
  reverseOrderFee,
  rechargeOrderFee,
  creditTopup,
  creditGatewayTopup,
  orderFeeState,
  describe,
  describeWallet,
  accessState,
  summary,
  ledger,
  serializeEntry,
  offeredFeePlan,
  startPayPerOrder,
  choosePayPerOrder,
  grantFreeOrders,
  adjustBalance,
};
