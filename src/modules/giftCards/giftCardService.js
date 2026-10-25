'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const secretBox = require('../../core/utils/secretBox');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * Gift cards: issue one, sell one as a product, redeem
 * it at checkout, check its balance.
 *
 * - A code is 16 characters (no 0/O/1/I), shown as XXXX-XXXX-XXXX-XXXX. It
 *   is found by an HMAC of the store and the code, kept sealed so staff can
 *   resend it, and shown elsewhere by its last 4.
 * - Values are the merchant's: what staff type, or the price of the gift-card
 *   product the shopper bought (one card per unit sold). No amount in code.
 * - Redeeming is a captured payment on the order (provider `gift_card`), so
 *   the cash a courier collects on a COD order is the total minus it, and the
 *   order's normal refund path credits the card back (giftCardProvider.js).
 *   A cancelled order gets its card balance back by itself (jobs.js).
 * - Every balance change is a gift_card_transactions row.
 * - Cash on delivery only: a card is not held against an online payment.
 * - Off (STORE_FEATURES without gift_cards): no card is redeemed or issued
 *   from an order; a cancelled order still gets back what a card paid, and a
 *   refund of a card payment still credits the card.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const key = () => crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:gift-card').digest();

const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashOf = (workspaceId, code) => crypto.createHmac('sha256', key()).update(`${workspaceId}:${normalize(code)}`).digest('hex');
const pretty = (code) => normalize(code).match(/.{1,4}/g).join('-');

function generateCode() {
  let out = '';
  for (let i = 0; i < 16; i += 1) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

function stateOf(card, now = new Date()) {
  if (card.status === 'disabled') return 'disabled';
  if (card.expiresAt && new Date(card.expiresAt) <= now) return 'expired';
  if (Number(card.balanceAmount) <= 0) return 'empty';
  return 'active';
}

const view = (c) => ({
  id: c.id,
  last4: c.last4,
  initialAmount: String(c.initialAmount),
  balanceAmount: String(c.balanceAmount),
  currency: c.currency,
  state: stateOf(c),
  status: c.status,
  expiresAt: c.expiresAt,
  source: c.source,
  orderId: c.orderId,
  customerId: c.customerId,
  recipientName: c.recipientName,
  recipientEmail: c.recipientEmail,
  message: c.message,
  note: c.note,
  createdAt: c.createdAt,
});

async function sendCardEmail(workspaceId, card, code) {
  if (!card.recipientEmail) return;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['name', 'defaultLocale'] });
  const amount = (Number(card.initialAmount) / 100).toFixed(2);
  const lang = workspace && workspace.defaultLocale === 'en' ? 'en' : 'ar';
  await require('../notifications/notify').email({
    recipient: card.recipientEmail,
    template: 'gift_card',
    data: { code: pretty(code), amount, currency: card.currency, storeName: workspace ? workspace.name : '', recipientName: card.recipientName, message: card.message, expiresAt: card.expiresAt, locale: lang },
    workspaceId,
  });
}

/**
 * A new card. `amount` in minor units. Returns { giftCard, code } — the code
 * in clear only here (and by `revealCode`).
 */
async function issue(workspaceId, { amount, currency, expiresAt = null, recipientName = null, recipientEmail = null, message = null, note = null, sendEmail = true }, { source = 'manual', orderId = null, orderItemId = null, unitIndex = null, customerId = null, actorUserId = null, req = null, transaction = null } = {}) {
  if (!Number.isInteger(amount) || amount <= 0) throw new AppError('VALIDATION_ERROR', 'A gift card needs a value', 422, [{ field: 'amount', message: 'Enter the card\'s value' }]);
  const run = async (t) => {
    let code;
    let card;
    for (let attempt = 0; attempt < 5 && !card; attempt += 1) {
      code = generateCode();
      try {
        card = await db.GiftCard.create(
          {
            workspaceId, codeHash: hashOf(workspaceId, code), codeSealed: secretBox.seal(code), last4: code.slice(-4),
            initialAmount: amount, balanceAmount: amount, currency: String(currency).toUpperCase(), expiresAt, source, orderId, orderItemId, unitIndex, customerId,
            recipientName, recipientEmail: recipientEmail ? recipientEmail.toLowerCase() : null, message, note, createdBy: actorUserId,
          },
          { transaction: t }
        );
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') throw err;
        // The same order unit twice: already issued.
        if (orderItemId !== null) return { giftCard: null, code: null, duplicate: true };
      }
    }
    await db.GiftCardTransaction.create({ workspaceId, giftCardId: card.id, kind: 'issue', amount, balanceAfter: amount, orderId, actorUserId, note: source === 'order' ? 'Bought on an order' : null }, { transaction: t });
    await recordAudit({ workspaceId, actorUserId, action: 'gift_card.issue', entityType: 'GiftCard', entityId: card.id, after: { amount, currency: card.currency, source, last4: card.last4 }, req, transaction: t });
    return { giftCard: card, code };
  };
  const out = transaction ? await run(transaction) : await db.sequelize.transaction(run);
  if (out.giftCard && sendEmail) await sendCardEmail(workspaceId, out.giftCard, out.code).catch((err) => logger.warn('[gift-cards] email failed', { message: err.message }));
  return out.giftCard ? { giftCard: view(out.giftCard), code: pretty(out.code) } : out;
}

async function findByCode(workspaceId, code, transaction, lock = false) {
  if (normalize(code).length !== 16) return null;
  return db.GiftCard.findOne({ where: { workspaceId, codeHash: hashOf(workspaceId, code) }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
}

/** The public balance check. Unknown codes and other stores' codes look the same. */
async function check(workspaceId, code) {
  const card = await findByCode(workspaceId, code);
  if (!card) throw new AppError('GIFT_CARD_NOT_FOUND', 'This gift card code is not valid', 404);
  return { last4: card.last4, balanceAmount: String(card.balanceAmount), currency: card.currency, state: stateOf(card), expiresAt: card.expiresAt };
}

/** Checkout, before the order exists: the card can pay part of an order in `currency`. */
async function assertUsable(workspaceId, code, currency) {
  const card = await findByCode(workspaceId, code);
  if (!card) throw new AppError('GIFT_CARD_NOT_FOUND', 'This gift card code is not valid', 422, [{ field: 'giftCardCode', message: 'This gift card code is not valid' }]);
  const state = stateOf(card);
  if (state !== 'active') {
    const msg = { expired: 'This gift card has expired', disabled: 'This gift card is no longer valid', empty: 'This gift card has no balance left' }[state];
    throw new AppError('GIFT_CARD_UNUSABLE', msg, 422, [{ field: 'giftCardCode', message: msg }]);
  }
  if (currency && card.currency !== String(currency).toUpperCase()) {
    throw new AppError('GIFT_CARD_UNUSABLE', `This gift card is in ${card.currency}`, 422, [{ field: 'giftCardCode', message: `This gift card is in ${card.currency}` }]);
  }
  return card;
}

/**
 * Takes what the card can pay of the order (at most what is still due) as a
 * captured `gift_card` payment. Never throws: a card spent meanwhile leaves
 * the order as it is, and says so.
 */
async function redeemOnOrder(order, code, req = null) {
  if (!storeFeatureOn('gift_cards')) return { applied: false, reason: 'unavailable' };
  try {
    return await db.sequelize.transaction(async (transaction) => {
      // The order first, then the card: the same order a refund takes them in (order locked, then the card credited).
      const locked = await db.Order.findOne({ where: { id: order.id }, transaction, lock: transaction.LOCK.UPDATE });
      const card = await findByCode(order.workspaceId, code, transaction, true);
      if (!card || stateOf(card) !== 'active' || card.currency !== order.currency) return { applied: false, reason: 'unusable' };
      const due = Math.max(0, Number(locked.totalAmount) - Number(locked.amountPaid));
      const amount = Math.min(due, Number(card.balanceAmount));
      if (amount <= 0) return { applied: false, reason: 'nothing_due' };
      const balance = Number(card.balanceAmount) - amount;
      await card.update({ balanceAmount: balance }, { transaction });
      const payment = await db.Payment.create(
        { workspaceId: order.workspaceId, orderId: order.id, providerCode: 'gift_card', status: 'captured', amount, currency: order.currency, providerReference: `${card.id}:${order.id}`, maskedDisplay: `Gift card •••• ${card.last4}`, method: 'gift_card' },
        { transaction }
      );
      await db.GiftCardTransaction.create({ workspaceId: order.workspaceId, giftCardId: card.id, kind: 'redeem', amount: -amount, balanceAfter: balance, orderId: order.id, paymentId: payment.id }, { transaction });
      const amountPaid = Number(locked.amountPaid) + amount;
      await locked.update({ amountPaid }, { transaction });
      await require('../orders/orderStateService').setFinancialState(order.workspaceId, order.id, amountPaid >= Number(locked.totalAmount) ? 'paid' : 'partially_paid', req, transaction);
      return { applied: true, amount: String(amount), last4: card.last4, balanceAmount: String(balance), currency: card.currency, paymentId: payment.id };
    });
  } catch (err) {
    logger.error('[gift-cards] redeem failed', { orderId: order.id, message: err.message });
    return { applied: false, reason: 'error' };
  }
}

/** Gives back to the card part of what it paid on an order (a refund of the gift_card payment). */
async function credit(cardId, orderId, amount, { kind = 'refund', note = null, actorUserId = null, transaction: outer = null } = {}) {
  const run = async (transaction) => {
    const card = await db.GiftCard.findByPk(cardId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!card) throw new NotFoundError('Gift card');
    const balance = Number(card.balanceAmount) + Number(amount);
    await card.update({ balanceAmount: balance }, { transaction });
    await db.GiftCardTransaction.create({ workspaceId: card.workspaceId, giftCardId: card.id, kind, amount: Number(amount), balanceAfter: balance, orderId, note, actorUserId }, { transaction });
    return card;
  };
  return outer ? run(outer) : db.sequelize.transaction(run);
}

/*
 * A processed refund of a gift_card payment credits its card in the refund's
 * own transaction (a Refund model hook), so the card and the order's refund
 * are saved together, once: the merchant's refund and a cancelled order's.
 */
async function onRefundProcessed(refund, options = {}) {
  if (refund.status !== 'processed' || !refund.paymentId) return;
  if (options.fields && !options.fields.includes('status')) return;
  const transaction = options.transaction || null;
  const payment = await db.Payment.findByPk(refund.paymentId, { transaction });
  if (!payment || payment.providerCode !== 'gift_card') return;
  const note = `refund:${refund.id}`;
  if (await db.GiftCardTransaction.count({ where: { note }, transaction })) return;
  const [cardId, orderId] = String(payment.providerReference || '').split(':');
  await credit(cardId, orderId || refund.orderId, Number(refund.amount), { kind: 'refund', note, transaction });
}
let hooked = false;
function installRefundHook() {
  if (hooked) return;
  hooked = true;
  db.Refund.addHook('afterCreate', 'zimosGiftCardRefund', onRefundProcessed);
  db.Refund.addHook('afterUpdate', 'zimosGiftCardRefund', onRefundProcessed);
}
installRefundHook();

/** order.cancelled: every gift-card payment not yet refunded goes back to its card, as a refund of the order. */
async function refundCancelledOrder(event) {
  const p = event.payload || {};
  const workspaceId = event.workspaceId || p.workspaceId;
  if (!workspaceId || !p.orderId) return null;
  // Most orders were paid by no card: nothing to lock for them.
  if (!(await db.Payment.count({ where: { workspaceId, orderId: p.orderId, providerCode: 'gift_card' } }))) return null;
  await db.sequelize.transaction(async (transaction) => {
    const order = await db.Order.findOne({ where: { id: p.orderId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    // Only a cancelled or rejected order gives its tender back: a reopen that beat this job keeps it.
    if (!order || (!order.cancelledAt && order.confirmationState !== 'rejected')) return;
    const payments = await db.Payment.findAll({ where: { workspaceId, orderId: order.id, providerCode: 'gift_card', status: 'captured' }, transaction });
    let refundedNow = 0;
    // Never more than the order still has to refund: a refund-to-credit already made counts.
    let room = Math.max(0, Number(order.amountPaid) - Number(order.amountRefunded));
    for (const payment of payments) {
      const refunded = await db.Refund.sum('amount', { where: { paymentId: payment.id, status: ['processed', 'pending'] }, transaction });
      const left = Math.min(Number(payment.amount) - Number(refunded || 0), room);
      if (left <= 0) continue;
      room -= left;
      // A refund row like the merchant's; its hook credits the card in this transaction.
      await db.Refund.create({ workspaceId, orderId: order.id, paymentId: payment.id, amount: left, reason: 'Order cancelled: gift card balance returned', status: 'processed', processedAt: new Date(), source: 'merchant' }, { transaction });
      refundedNow += left;
    }
    if (!refundedNow) return;
    const amountRefunded = Number(order.amountRefunded) + refundedNow;
    await order.update({ amountRefunded }, { transaction });
    await require('../orders/orderStateService').setFinancialState(workspaceId, order.id, amountRefunded >= Number(order.amountPaid) ? 'refunded' : 'partially_refunded', null, transaction);
  });
  return null;
}

/** order.paid / order.delivered: one card per unit of every gift-card product line. */
async function issueForOrder(event) {
  if (!storeFeatureOn('gift_cards')) return null;
  const p = event.payload || {};
  const workspaceId = event.workspaceId || p.workspaceId;
  if (!workspaceId || !p.orderId) return null;
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const settings = settingsOf(workspace);
  if (!settings.productIds.length) return null;
  const order = await db.Order.findOne({ where: { id: p.orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items' }] });
  if (!order || order.cancelledAt || order.isTest) return null;
  // Paid in full, or delivered (cash collected): the card is earned.
  if (!(order.financialState === 'paid' || event.type === 'order.delivered')) return null;
  const contact = order.contactSnapshot || {};
  for (const item of order.items.filter((i) => settings.productIds.includes(i.productId))) {
    for (let unit = 0; unit < item.quantity; unit += 1) {
      const expiresAt = settings.validityDays ? new Date(Date.now() + settings.validityDays * 864e5) : null;
      await issue(workspaceId, { amount: Number(item.unitPriceAmount), currency: order.currency, expiresAt, recipientName: contact.fullName || null, recipientEmail: contact.email || null }, { source: 'order', orderId: order.id, orderItemId: item.id, unitIndex: unit, customerId: order.customerId });
    }
  }
  return null;
}

function settingsOf(workspace) {
  const s = (workspace && workspace.settings && workspace.settings.gift_cards) || {};
  return { productIds: Array.isArray(s.productIds) ? s.productIds : [], validityDays: Number.isInteger(s.validityDays) ? s.validityDays : null };
}

// ------------------------------------------------------------------ staff --

// A card bought on an order took its recipient from that order's customer: while the order is
// locked (orders/orderLock) the card shows, its recipient does not.
const RECIPIENT_FIELDS = ['recipientName', 'recipientEmail', 'message'];

async function lockedCardIds(workspaceId, cards) {
  const orderLock = require('../orders/orderLock');
  const orderIds = [...new Set(cards.map((c) => c.orderId).filter(Boolean))];
  if (!orderLock.enabled() || orderIds.length === 0) return new Set();
  const ctx = await orderLock.contextFor(workspaceId);
  if (orderLock.isOpenContext(ctx)) return new Set();
  const orders = await db.Order.findAll({ where: { id: orderIds, workspaceId }, attributes: orderLock.ORDER_ATTRIBUTES });
  const locked = await orderLock.lockedIds(ctx, orders);
  return new Set(cards.filter((c) => locked.has(c.orderId)).map((c) => c.id));
}

const shownView = (card, locked) => (locked.has(card.id) ? require('../orders/orderLock').maskFields(view(card), RECIPIENT_FIELDS) : view(card));

async function list(workspaceId, { state, q, limit = 50, before }) {
  const where = { workspaceId };
  if (q) {
    const n = normalize(q);
    if (n.length === 16) where.codeHash = hashOf(workspaceId, n);
    else if (/^[A-Z0-9]{4}$/.test(n)) where.last4 = n;
    else {
      where.recipientEmail = { [Op.iLike]: `%${String(q).trim()}%` };
      // Never found by the email of a locked order's customer.
      const orderLock = require('../orders/orderLock');
      const ctx = await orderLock.contextFor(workspaceId);
      if (!orderLock.isOpenContext(ctx)) {
        where[Op.and] = [db.sequelize.literal(`NOT EXISTS (SELECT 1 FROM orders go WHERE go.id = "GiftCard"."order_id" AND NOT ${orderLock.visibleSql(ctx, 'go')})`)];
      }
    }
  }
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.GiftCard.findAll({ where, order: [['createdAt', 'DESC']], limit: 200 });
  const filtered = state ? rows.filter((r) => stateOf(r) === state) : rows;
  const page = filtered.slice(0, limit);
  const locked = await lockedCardIds(workspaceId, page);
  return { giftCards: page.map((c) => shownView(c, locked)), nextBefore: filtered.length > limit ? page[page.length - 1].createdAt.toISOString() : null };
}

async function get(workspaceId, id) {
  const card = await db.GiftCard.findOne({ where: { id, workspaceId } });
  if (!card) throw new NotFoundError('Gift card');
  const transactions = await db.GiftCardTransaction.findAll({ where: { giftCardId: id }, order: [['createdAt', 'DESC']], limit: 100 });
  const locked = await lockedCardIds(workspaceId, [card]);
  return { giftCard: shownView(card, locked), transactions: transactions.map((t) => ({ id: t.id, kind: t.kind, amount: String(t.amount), balanceAfter: String(t.balanceAfter), orderId: t.orderId, note: t.note, createdAt: t.createdAt })) };
}

/** 402 ORDER_LOCKED when the card's order is locked: its recipient is that order's hidden customer. */
async function assertRecipientShown(workspaceId, card) {
  if ((await lockedCardIds(workspaceId, [card])).has(card.id)) await require('../orders/orderLock').assertUnlocked(workspaceId, card.orderId);
}

async function update(workspaceId, id, body, req) {
  const card = await db.GiftCard.findOne({ where: { id, workspaceId } });
  if (!card) throw new NotFoundError('Gift card');
  // Its status, expiry and balance can still change; not who it is for.
  if (body.recipientName !== undefined || body.recipientEmail !== undefined) await assertRecipientShown(workspaceId, card);
  const locked = await lockedCardIds(workspaceId, [card]);
  const before = shownView(card, locked);
  const changes = {};
  for (const k of ['status', 'expiresAt', 'note', 'recipientName', 'recipientEmail']) if (body[k] !== undefined) changes[k] = body[k];
  await card.update(changes);
  if (body.adjustBy) {
    if (Number(card.balanceAmount) + body.adjustBy < 0) throw new AppError('VALIDATION_ERROR', 'The balance cannot go below zero', 422, [{ field: 'adjustBy', message: `At most ${card.balanceAmount} can be taken off` }]);
    await credit(card.id, null, body.adjustBy, { kind: 'adjust', note: body.adjustNote || null, actorUserId: req.user.id });
    await card.reload();
  }
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'gift_card.update', entityType: 'GiftCard', entityId: card.id, before, after: shownView(card, locked), req });
  return get(workspaceId, id);
}

async function revealCode(workspaceId, id, { resend = false } = {}, req) {
  const card = await db.GiftCard.findOne({ where: { id, workspaceId } });
  if (!card) throw new NotFoundError('Gift card');
  // Sending it again emails a locked order's customer (orders/orderLock): not while locked.
  if (resend) await assertRecipientShown(workspaceId, card);
  const code = secretBox.open(card.codeSealed);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: resend ? 'gift_card.resend' : 'gift_card.reveal', entityType: 'GiftCard', entityId: card.id, req });
  if (resend) {
    if (!card.recipientEmail) throw new AppError('GIFT_CARD_NO_EMAIL', 'Add the recipient\'s email first', 422);
    await sendCardEmail(workspaceId, card, code);
  }
  return { code: pretty(code), sent: Boolean(resend) };
}

module.exports = { findByCode, issue, check, assertUsable, redeemOnOrder, credit, refundCancelledOrder, issueForOrder, settingsOf, list, get, update, revealCode, normalize, stateOf };
