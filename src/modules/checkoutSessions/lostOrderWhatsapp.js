'use strict';

const asyncHandler = require('express-async-handler');
const Joi = require('joi');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * The lost orders list's "WhatsApp" action (SPEC §6.3: "recovery template with
 * a /r/:token link"), sent through the store's connected WhatsApp number
 * rather than the teammate's own phone.
 *
 * The template is the one the ready "Abandoned cart recovery" automation uses
 * (`cart_reminder`, automations/automationTemplates.js) unless another is
 * named. Its {{1}}…{{n}} take, in order: the customer's name, the store's
 * name, the recovery link, the total, the products — as many as the template
 * has (its synced variable count; 3 when it was never synced). A phone that
 * answered STOP, or is blocked, is refused like any marketing message
 * (automations/marketingGuard.js). The message lands in the inbox, and the
 * lost order is marked contacted.
 *
 *   POST /workspaces/:ws/checkout-sessions/:sessionId/whatsapp  { template?, language? }
 *
 * Codes: WHATSAPP_NOT_CONNECTED (422), WHATSAPP_TEMPLATE_NOT_APPROVED (422),
 * MARKETING_NOT_ALLOWED (422), NO_PHONE (422).
 */

const DEFAULT_TEMPLATE = 'cart_reminder';
const PARAM_ORDER = ['customer_name', 'store_name', 'recovery_link', 'order_total', 'product_names'];

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required(), sessionId: Joi.string().uuid().required() }),
  body: Joi.object({
    template: Joi.string().pattern(/^[a-z0-9_]{1,512}$/),
    language: Joi.string().max(15),
  }).default({}),
};

const send = asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  const session = await db.CheckoutSession.findOne({ where: { id: req.params.sessionId, workspaceId } });
  if (!session) throw new NotFoundError('CheckoutSession');
  // No message to the shopper while new orders are locked (402 ORDER_LOCKED, orders/orderLock).
  await require('../orders/orderLock').assertPendingOpen(workspaceId);

  const subject = await require('../automations/automationContext').loadCheckoutSubject(workspaceId, session.id);
  const phone = (subject && subject.phone) || require('./lostOrderPhones').phoneOf(session);
  if (!phone) throw new AppError('NO_PHONE', 'This lost order has no phone number', 422);
  const refused = await require('../automations/marketingGuard').refusal(workspaceId, phone);
  if (refused) throw new AppError('MARKETING_NOT_ALLOWED', `Not sent: ${refused}`, 422);

  const name = req.body.template || DEFAULT_TEMPLATE;
  const language = req.body.language || 'ar';
  const synced = await db.WhatsappTemplate.findOne({ where: { workspaceId, name, language }, attributes: ['paramsCount'] });
  const count = synced ? synced.paramsCount : 3;
  const params = PARAM_ORDER.slice(0, count).map((key) => String((subject && subject.vars[key]) || '—'));

  const message = await require('../whatsapp/whatsappService').sendMessage(workspaceId, { to: phone, template: { name, language, params } }, req);
  if (session.recoveryStatus === 'not_contacted') await session.update({ recoveryStatus: 'contacted' });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'lost_order.whatsapp_sent',
    entityType: 'CheckoutSession',
    entityId: session.id,
    after: { template: name, messageId: message.id },
    req,
  });
  res.json({ message: { id: message.id, conversationId: message.conversationId, status: message.status }, recoveryStatus: session.recoveryStatus });
});

module.exports = { schema, send, DEFAULT_TEMPLATE };
