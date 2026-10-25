'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const queue = require('../../core/queue');
const logger = require('../../core/utils/logger');

/**
 * WhatsApp quick-reply confirmation (SPEC §14.2, template 1).
 *
 * The order-confirmation template carries two quick-reply buttons, "Confirm
 * order" and "Cancel". When the customer taps one, Meta's webhook delivers a
 * button message that names the message it answers. This module turns that
 * tap into the same outcome an agent would record: the order is confirmed (or
 * cancelled) and its confirmation task is closed — no phone call needed.
 *
 * Which order: the outbound message being answered (whatsapp_messages.order_id,
 * set when an automation sends about an order). If the reply names no message
 * we know, the customer's single open cash-on-delivery order that we messaged
 * about in the last three days — never a guess between two.
 *
 * What counts as a reply: a button tap always; typed text only when it is
 * exactly one of the words below *and* it quotes one of our order messages.
 * Anything else stays an ordinary inbox message for a person to read.
 *
 * "Cancel" cancels only when it answers the confirmation message itself
 * (the `order_confirmation` template) about a cash-on-delivery order still
 * waiting for its confirmation. A "no" to any other message changes nothing;
 * a cancel the order is past (confirmed already, postponed, paid online…) is
 * passed to the team instead of cancelling.
 */

const JOB = 'whatsapp.quick_reply';
const WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
// The confirmation message: the ready-made automation's and the order page's (orders/whatsappConfirm.js).
const CONFIRMATION_TEMPLATE = 'order_confirmation';

const normalise = (text) =>
  String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '') // Arabic diacritics and tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[.!؟?]+$/g, '')
    .replace(/\s+/g, ' ');

const CONFIRM = new Set(['تاكيد الطلب', 'تاكيد', 'اكد الطلب', 'اكد', 'موافق', 'نعم', 'confirm order', 'confirm', 'yes'].map(normalise));
const CANCEL = new Set(['الغاء الطلب', 'الغاء', 'الغي الطلب', 'الغي', 'لا', 'cancel order', 'cancel', 'no'].map(normalise));

/** 'confirm' | 'cancel' | null for one inbound webhook message. */
function intentOf(msg) {
  let text = null;
  let isButton = false;
  if (msg.type === 'button' && msg.button) {
    text = msg.button.payload || msg.button.text;
    isButton = true;
    // A template's payload may be a developer string; fall back to the label.
    if (!CONFIRM.has(normalise(text)) && !CANCEL.has(normalise(text))) text = msg.button.text;
  } else if (msg.type === 'interactive' && msg.interactive && msg.interactive.button_reply) {
    text = msg.interactive.button_reply.title || msg.interactive.button_reply.id;
    isButton = true;
  } else if (msg.type === 'text' && msg.text && msg.context && msg.context.id) {
    text = msg.text.body;
  }
  if (!text) return null;
  const key = normalise(text);
  if (CONFIRM.has(key)) return { intent: 'confirm', isButton };
  if (CANCEL.has(key)) return { intent: 'cancel', isButton };
  return null;
}

/** Called by the webhook for every new inbound message; queues the ones that are replies. */
async function enqueue(workspaceId, msg, phoneNormalized) {
  try {
    const found = intentOf(msg);
    if (!found) return false;
    await queue.add(
      'notifications',
      JOB,
      { intent: found.intent, isButton: found.isButton, phoneNormalized, repliedToWaMessageId: (msg.context && msg.context.id) || null, waMessageId: msg.id || null },
      { workspaceId, dedupeKey: msg.id ? `waqr:${msg.id}` : undefined }
    );
    return true;
  } catch (err) {
    logger.error(`[whatsapp.quick_reply] could not queue a reply for ${workspaceId}: ${err.message}`);
    return false;
  }
}

/** { order } for the reply, or { order: null, reason } when it answers nothing it may act on. */
async function findOrder(workspaceId, { phoneNormalized, repliedToWaMessageId, isButton, intent }) {
  if (repliedToWaMessageId) {
    const sent = await db.WhatsappMessage.findOne({
      where: { workspaceId, waMessageId: repliedToWaMessageId, direction: 'out', orderId: { [Op.ne]: null } },
      attributes: ['orderId', 'templateName'],
    });
    if (sent) {
      // A "no" to a shipping, delivery or review message is not a cancellation.
      if (intent === 'cancel' && sent.templateName !== CONFIRMATION_TEMPLATE) return { order: null, reason: 'not an answer to the confirmation message' };
      return { order: await db.Order.findOne({ where: { id: sent.orderId, workspaceId } }) };
    }
  }
  // Typed text must quote one of our order messages; only a button tap may fall back.
  if (!isButton) return { order: null };
  const conversation = await db.WhatsappConversation.findOne({ where: { workspaceId, phoneNormalized }, attributes: ['id'] });
  if (!conversation) return { order: null };
  const recent = await db.WhatsappMessage.findAll({
    where: {
      workspaceId,
      conversationId: conversation.id,
      direction: 'out',
      orderId: { [Op.ne]: null },
      createdAt: { [Op.gt]: new Date(Date.now() - WINDOW_MS) },
      ...(intent === 'cancel' ? { templateName: CONFIRMATION_TEMPLATE } : {}),
    },
    attributes: ['orderId'],
  });
  const orderIds = [...new Set(recent.map((m) => m.orderId))];
  if (orderIds.length === 0) return { order: null };
  const open = await db.Order.findAll({
    where: { workspaceId, id: orderIds, paymentMethod: 'cod', confirmationState: 'pending', cancelledAt: null },
  });
  return { order: open.length === 1 ? open[0] : null };
}

async function tellTeam(workspaceId, order, message, dedupeKey = null) {
  const merchantNotifications = require('../notifications/merchantNotificationService');
  await merchantNotifications.create(workspaceId, {
    type: 'automation',
    title: `رد العميل على واتساب — ${order.orderNumber}`,
    body: message,
    link: `/orders/${order.id}`,
    data: { message, orderId: order.id },
    dedupeKey,
  });
}

/** A tap cancels only a cash-on-delivery order still waiting for its confirmation. */
const cancellableByTap = (order) => order.paymentMethod === 'cod' && order.confirmationState === 'pending';

/** The queue job. Returns what it did, for the job log. */
async function process(job) {
  const { workspaceId } = job;
  const { intent } = job.payload;
  const { order, reason } = await findOrder(workspaceId, job.payload);
  if (!order) return { done: false, reason: reason || 'no matching order' };

  // Already where the customer wants it (a second tap, or an agent got there first).
  if (intent === 'confirm' && order.confirmationState === 'confirmed') return { done: false, reason: 'already confirmed' };
  if (order.cancelledAt || (intent === 'cancel' && order.confirmationState === 'rejected')) return { done: false, reason: 'already cancelled' };

  // "Cancel" on an order that is past waiting for its confirmation: nothing changes, a person
  // talks to the customer. Told once per order, however many times the button is tapped.
  if (intent === 'cancel' && !cancellableByTap(order)) {
    await tellTeam(
      workspaceId,
      order,
      order.confirmationState === 'confirmed'
        ? 'العميل ضغط "إلغاء" على رسالة التأكيد بعد تأكيد الطلب، فلم يُلغَ الطلب. تواصلوا مع العميل قبل الشحن.'
        : 'العميل ضغط "إلغاء" على رسالة التأكيد، ولم يُلغَ الطلب تلقائيًا لأنه ليس طلب دفع عند الاستلام في انتظار التأكيد. راجعوه مع العميل.',
      `waqr.cancel_refused:${order.id}`
    );
    return { done: false, reason: 'not a cash-on-delivery order waiting for its confirmation', orderId: order.id };
  }

  // Lazy requires: these modules reach back into whatsapp through automations.
  const { systemRequest } = require('../automations/automationSteps');
  const req = await systemRequest(workspaceId);
  try {
    if (intent === 'confirm') {
      await require('../cod/confirmationService').confirmFromOrder(workspaceId, order.id, { notes: 'العميل أكّد الطلب بزر واتساب', channel: 'whatsapp' }, req);
    } else {
      // Checked again under the order's lock: an agent may confirm it in the meantime.
      await require('../orders/orderService').cancelOrder(workspaceId, order.id, { reason: 'العميل ألغى الطلب بزر واتساب', onlyWhilePendingCod: true }, req);
    }
    return { done: true, intent, orderId: order.id };
  } catch (err) {
    // The order could not be changed by itself (an agent holds the task, it
    // already shipped, the courier must be told…): a person takes it from here.
    await tellTeam(
      workspaceId,
      order,
      intent === 'confirm' ? `العميل ضغط "تأكيد الطلب" لكن لم يتم التأكيد تلقائيًا: ${err.message}` : `العميل ضغط "إلغاء" لكن لم يتم الإلغاء تلقائيًا: ${err.message}`
    );
    return { done: false, reason: err.message, orderId: order.id };
  }
}

module.exports = { JOB, intentOf, enqueue, process };
