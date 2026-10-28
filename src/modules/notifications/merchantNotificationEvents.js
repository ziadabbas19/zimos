'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { toDisplay } = require('../../core/utils/money');
const service = require('./merchantNotificationService');
const pushConfig = require('./push/pushConfig');

/**
 * Where business events become merchant notifications. Other modules call one
 * function here from `transaction.afterCommit` (the same fire-and-forget
 * pattern as automationEngine.emit) and know nothing about recipients,
 * preferences or channels.
 */

const today = () => new Date().toISOString().slice(0, 10);

const variantLabel = (variant) => {
  const options = Object.values(variant.optionValues || {}).join(' / ');
  const name = variant.product ? variant.product.name : '';
  return [name, options].filter(Boolean).join(' — ') || variant.sku || variant.id;
};

/** A new order: tell the team, flag it if the fraud rules did, and warn about stock it used up. */
async function orderCreated(workspaceId, orderId) {
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    include: [{ model: db.OrderItem, as: 'items', attributes: ['variantId'], required: false }],
  });
  if (!order) return;
  // A locked order's customer is not named, here or in the e-mail and WhatsApp alert built from it (orders/orderLock).
  const orderLock = require('../orders/orderLock');
  const customerName = (await orderLock.isLocked(order)) ? orderLock.MASK : (order.contactSnapshot || {}).fullName || '';
  const total = `${toDisplay(order.totalAmount)} ${order.currency}`;
  const data = { orderId: order.id, orderNumber: order.orderNumber, customerName, total };
  const link = `/orders/${order.id}`;

  await service.create(workspaceId, {
    type: 'order.new',
    title: `طلب جديد ${order.orderNumber}`,
    body: [customerName, total].filter(Boolean).join(' — '),
    link,
    data,
    dedupeKey: `order.new:${order.id}`,
  });

  if ((order.riskFlags || []).length > 0) {
    await service.create(workspaceId, {
      type: 'order.suspicious',
      title: `طلب مشتبه به ${order.orderNumber}`,
      body: 'قواعد الحماية علّمت هذا الطلب للمراجعة قبل تأكيده.',
      link,
      data: { ...data, riskFlags: order.riskFlags },
      dedupeKey: `order.suspicious:${order.id}`,
    });
  }

  const variantIds = [...new Set((order.items || []).map((i) => i.variantId).filter(Boolean))];
  if (variantIds.length === 0) return;
  const variants = await db.ProductVariant.findAll({
    where: { workspaceId, id: variantIds, status: 'active' },
    include: [{ model: db.Product, as: 'product', attributes: ['id', 'name'] }],
  });
  for (const variant of variants) {
    if (variant.lowStockThreshold === null || variant.lowStockThreshold === undefined) continue;
    const available = variant.stockOnHand - variant.reservedStock;
    if (available > variant.lowStockThreshold) continue;
    const label = variantLabel(variant);
    await service.create(workspaceId, {
      type: 'stock.low',
      title: `المخزون قارب على النفاد: ${label}`,
      body: `المتاح ${available} قطعة.`,
      link: `/catalog/${variant.productId}`,
      data: { productId: variant.productId, variantId: variant.id, label, available },
      // One reminder a day per variant, however many orders it appears in.
      dedupeKey: `stock.low:${variant.id}:${today()}`,
    });
  }
}

/** A connected service (gateway, courier, WhatsApp) stopped working. Once a day per integration. */
function integrationFailed(workspaceId, { integration, message, link = '/settings' }) {
  return service.create(workspaceId, {
    type: 'integration.failed',
    title: `تعذّر الاتصال بـ ${integration}`,
    body: message ? String(message).slice(0, 500) : null,
    link,
    data: { integration, message: message ? String(message).slice(0, 500) : null },
    dedupeKey: `integration.failed:${integration}:${today()}`,
  });
}

/**
 * A shopper's checkout code reached them on no channel, so their order went
 * through unverified and marked (risk/checkoutOtp, CHECKOUT_OTP_DELIVERY_GUARD).
 * Once a day, under the "a connected service stopped working" preference.
 */
function checkoutOtpUndelivered(workspaceId) {
  return service.create(workspaceId, {
    type: 'integration.failed',
    title: 'تعذّر إرسال رمز التحقق إلى العملاء',
    body: 'لم يصل رمز التحقق إلى عميل عبر واتساب ولا الرسائل النصية، فقُبل طلبه دون تحقق وعليه علامة «تعذّر إرسال رمز التحقق». راجع الطلبات المعلَّمة قبل تأكيدها.',
    link: '/fraud',
    data: { integration: 'checkout_otp' },
    dedupeKey: `integration.failed:checkout_otp:${today()}`,
  });
}

/** A file one teammate asked for is ready. */
function exportReady(workspaceId, userId, { name, link }) {
  return service.create(workspaceId, {
    type: 'export.ready',
    title: `الملف جاهز: ${name}`,
    link,
    data: { name },
    userIds: [userId],
  });
}

const money = (minor, currency) => `${toDisplay(minor)} ${currency}`;

/** The prepaid balance is low or below zero (billing/walletService, a plan with a debt limit). Once a day. */
function walletLow(workspaceId, wallet) {
  return service.create(workspaceId, {
    type: 'wallet.low',
    title: wallet.balance <= 0 ? 'رصيد Zimos أصبح صفرًا أو أقل' : 'رصيد Zimos يقترب من النفاد',
    body: `الرصيد ${money(wallet.balance, wallet.currency)}. اشحنه حتى لا تتوقف الطلبات الجديدة.`,
    link: '/subscription?tab=usage',
    data: { balance: wallet.balance, fee: wallet.fee, ordersLeft: wallet.ordersLeft, currency: wallet.currency },
    dedupeKey: `wallet.low:${today()}`,
  });
}

/** The balance reached the plan's debt limit: new orders are refused until a top-up. Once a day. */
function walletLimitReached(workspaceId, wallet) {
  return service.create(workspaceId, {
    type: 'wallet.limit_reached',
    title: 'وصل رصيد Zimos إلى الحد: الطلبات الجديدة متوقفة',
    body: `المديونية ${money(wallet.debt, wallet.currency)}. اشحن رصيدك لتعود الطلبات الجديدة.`,
    link: '/subscription?tab=usage',
    data: { balance: wallet.balance, debt: wallet.debt, limit: wallet.overdraft, currency: wallet.currency },
    dedupeKey: `wallet.limit_reached:${today()}`,
  });
}

const REFUND_TITLES = {
  requested: 'تم استلام طلب استرداد رصيد Zimos',
  approved: 'تمت الموافقة على طلب الاسترداد',
  rejected: 'تم رفض طلب الاسترداد وعاد المبلغ إلى رصيدك',
  cancelled: 'تم إلغاء طلب الاسترداد وعاد المبلغ إلى رصيدك',
  paid: 'تم تحويل مبلغ الاسترداد',
};

/** A refund request of the prepaid balance changed status. Once per request and status. */
function walletRefund(workspaceId, request) {
  return service.create(workspaceId, {
    type: 'wallet.refund',
    title: REFUND_TITLES[request.status] || 'تحديث على طلب الاسترداد',
    body: `${money(request.amount, request.currency)}${request.status === 'rejected' && request.adminNote ? ` — ${request.adminNote}` : ''}`,
    link: '/subscription?tab=usage',
    data: { refundId: request.id, status: request.status, amount: request.amount, currency: request.currency, note: request.adminNote || null },
    dedupeKey: `wallet.refund:${request.id}:${request.status}`,
  });
}

/** Zimos added credit to the prepaid balance and chose to say so. */
function walletCredit(workspaceId, { entryId, amount, currency, kind, reason }) {
  return service.create(workspaceId, {
    type: 'wallet.credit',
    title: kind === 'gift' ? 'أضاف فريق Zimos رصيدًا هدية إلى محفظتك' : 'عدّل فريق Zimos رصيد محفظتك',
    body: `${money(amount, currency)}${reason ? ` — ${reason}` : ''}`,
    link: '/subscription?tab=usage',
    data: { entryId, amount, currency, kind, reason: reason || null },
    dedupeKey: `wallet.credit:${entryId}`,
  });
}

/** The subscription ended and the store moved to pay per order, paid from its balance. Once per change. */
function walletFallback(workspaceId, { subscriptionId, fromPlan, fee }) {
  return service.create(workspaceId, {
    type: 'wallet.fallback',
    title: 'انتهى اشتراكك، ومتجرك الآن على الدفع لكل طلب',
    body: `انتهت خطة ${fromPlan}، فيستمر متجرك في البيع ويُخصم ${money(fee, 'EGP')} لكل طلب من رصيدك. يمكنك العودة إلى اشتراك في أي وقت.`,
    link: '/subscription?tab=plans',
    data: { fromPlan, fee, currency: 'EGP' },
    dedupeKey: `wallet.fallback:${subscriptionId}:${today()}`,
  });
}

/*
 * The three that came with device notifications (decision 6 of
 * REPORT-push-notifications.md): nothing at all while push is off
 * (service.create refuses them too), so the bell is what it was before.
 */

/**
 * An order paid online or by a transfer whose proof was approved (the
 * order.paid event, notifications/jobs.js). Cash on delivery is left out: a
 * courier's settlement marks hundreds of orders paid at once, and the team
 * already saw each of them arrive.
 */
async function orderPaid(workspaceId, orderId) {
  if (!pushConfig.isOn()) return null;
  const order = await db.Order.findOne({
    where: { id: orderId, workspaceId },
    attributes: ['id', 'orderNumber', 'totalAmount', 'currency', 'paymentMethod', 'financialState'],
  });
  if (!order || order.paymentMethod === 'cod' || order.financialState !== 'paid') return null;
  const total = `${toDisplay(Number(order.totalAmount))} ${order.currency}`;
  return service.create(workspaceId, {
    type: 'order.paid',
    title: `تم دفع الطلب ${order.orderNumber}`,
    body: total,
    link: `/orders/${order.id}`,
    data: { orderId: order.id, orderNumber: order.orderNumber, total },
    dedupeKey: `order.paid:${order.id}`,
  });
}

/** A checkout filed as a lost order (the lost_order.created event). Who it was is on the lost orders page, not here. */
async function lostOrderCreated(workspaceId, checkoutSessionId) {
  if (!pushConfig.isOn()) return null;
  return service.create(workspaceId, {
    type: 'lost_order.new',
    title: 'طلب مفقود جديد',
    body: 'لم يكتمل طلب أحد العملاء. تجده في صفحة الطلبات المفقودة.',
    link: '/abandoned-carts',
    data: { checkoutSessionId },
    dedupeKey: `lost_order.new:${checkoutSessionId}`,
  });
}

/**
 * A customer wrote on WhatsApp: a device notification only (no bell row),
 * gathered per conversation for 5 minutes. Not what they wrote, nor who they
 * are. Called by the inbox's incoming messages (session P2).
 */
function whatsappMessage(workspaceId, { conversationId }) {
  if (!pushConfig.isOn()) return Promise.resolve(null);
  return service.create(workspaceId, {
    type: 'whatsapp.message',
    title: 'رسالة واتساب جديدة',
    link: '/inbox',
    data: { conversationId },
  });
}

const HANDLERS = { 'order.created': orderCreated };

/** Fire-and-forget, like automationEngine.emit; awaited under test for the same reason. */
function emit(workspaceId, event, entityId) {
  const handler = HANDLERS[event];
  if (!handler) return undefined;
  const work = handler(workspaceId, entityId).catch((err) =>
    logger.error(`[merchant-notifications] ${event} for ${entityId} failed: ${err.message}`)
  );
  return env.isTest ? work : undefined;
}

module.exports = {
  emit,
  orderCreated,
  orderPaid,
  lostOrderCreated,
  whatsappMessage,
  integrationFailed,
  checkoutOtpUndelivered,
  exportReady,
  walletLow,
  walletLimitReached,
  walletRefund,
  walletCredit,
  walletFallback,
};
