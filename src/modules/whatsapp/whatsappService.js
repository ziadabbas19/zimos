'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const inboxEvents = require('./inboxEvents');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const logger = require('../../core/utils/logger');
const secretBox = require('../../core/utils/secretBox');
const { recordAudit } = require('../audit/auditService');
const cloud = require('./whatsappCloud');

const PROVIDER = 'whatsapp_cloud';
const WINDOW_MS = 24 * 60 * 60 * 1000;

async function getIntegration(workspaceId) {
  return db.WorkspaceIntegration.findOne({ where: { workspaceId, provider: PROVIDER } });
}

function secretsOf(integration) {
  return JSON.parse(secretBox.open(integration.secretsSealed) || '{}');
}

/** What the dashboard sees: never the token or app secret, only masks. */
function integrationView(integration, apiBase) {
  if (!integration) return { connected: false };
  const secrets = secretsOf(integration);
  const cfg = integration.config || {};
  return {
    connected: integration.status === 'connected',
    status: integration.status,
    phoneNumberId: cfg.phoneNumberId,
    businessAccountId: cfg.businessAccountId || null,
    displayPhoneNumber: cfg.displayPhoneNumber || null,
    verifiedName: cfg.verifiedName || null,
    accessTokenMask: secretBox.mask(secrets.accessToken),
    appSecretSet: Boolean(secrets.appSecret),
    webhook: {
      url: `${apiBase}/webhooks/whatsapp/${integration.workspaceId}`,
      verifyToken: cfg.verifyToken,
    },
    lastVerifiedAt: integration.lastVerifiedAt,
    lastError: integration.lastError,
  };
}

async function connect(workspaceId, { phoneNumberId, accessToken, businessAccountId, appSecret }, req) {
  const existing = await getIntegration(workspaceId);
  // Everything that can fail on our side fails before the token goes to Meta: the
  // stored secrets are opened and the new ones sealed first (INTEGRATIONS_ENCRYPTION_KEY).
  const previous = existing ? secretsOf(existing) : {};
  // The App Secret signs every webhook; without it each one is refused (401), so no
  // reply or confirmation tap would ever arrive. A reconnect may keep the saved one.
  const secret = appSecret || previous.appSecret || null;
  if (!secret) {
    throw new AppError('WHATSAPP_APP_SECRET_REQUIRED', "The App Secret is required: without it Meta's messages can't be checked and none of them can be received", 422);
  }
  const secretsSealed = secretBox.seal(JSON.stringify({ accessToken, appSecret: secret }));
  const details = await cloud.verifyPhoneNumber(phoneNumberId, accessToken);
  const config = {
    phoneNumberId,
    businessAccountId: businessAccountId || null,
    displayPhoneNumber: details.displayPhoneNumber,
    verifiedName: details.verifiedName,
    verifyToken: (existing && existing.config && existing.config.verifyToken) || crypto.randomBytes(18).toString('hex'),
  };
  const fields = { workspaceId, provider: PROVIDER, status: 'connected', config, secretsSealed, lastVerifiedAt: new Date(), lastError: null };
  const integration = existing ? await existing.update(fields) : await db.WorkspaceIntegration.create(fields);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'integration.whatsapp.connect', entityType: 'WorkspaceIntegration', entityId: integration.id, after: { phoneNumberId, displayPhoneNumber: details.displayPhoneNumber }, req });
  // The account's templates and their status, for the pickers (whatsappTemplates.js).
  void require('./whatsappTemplates').syncQuietly(workspaceId);
  return integration;
}

async function disconnect(workspaceId, req) {
  const integration = await getIntegration(workspaceId);
  if (!integration) return { disconnected: false };
  await integration.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'integration.whatsapp.disconnect', entityType: 'WorkspaceIntegration', entityId: integration.id, req });
  return { disconnected: true };
}

async function requireConnected(workspaceId) {
  const integration = await getIntegration(workspaceId);
  if (!integration || integration.status !== 'connected') {
    throw new AppError('WHATSAPP_NOT_CONNECTED', 'Connect WhatsApp in Settings → Integrations first', 422);
  }
  return integration;
}

async function upsertConversation(workspaceId, phoneNormalized, { customerName, transaction } = {}) {
  const [conversation] = await db.WhatsappConversation.findOrCreate({
    where: { workspaceId, phoneNormalized },
    defaults: { workspaceId, phoneNormalized, customerName: customerName || null },
    transaction,
  });
  if (!conversation.customerId || (!conversation.customerName && customerName)) {
    const customer = await db.Customer.findOne({ where: { workspaceId, phoneNormalized }, attributes: ['id', 'fullName'], transaction });
    await conversation.update(
      { customerId: customer ? customer.id : conversation.customerId, customerName: conversation.customerName || customerName || (customer ? customer.fullName : null) },
      { transaction }
    );
  }
  return conversation;
}

/**
 * Sends a message from the store and records it (a failed send is recorded
 * as failed and re-thrown so the caller sees the WhatsApp error).
 */
async function sendMessage(workspaceId, { to, text, template, orderId = null }, req) {
  const integration = await requireConnected(workspaceId);
  const phoneNormalized = normalizePhone(to);
  if (!phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  const conversation = await upsertConversation(workspaceId, phoneNormalized);

  if (text && !template) {
    const inWindow = conversation.lastInboundAt && Date.now() - new Date(conversation.lastInboundAt).getTime() < WINDOW_MS;
    if (!inWindow) {
      throw new AppError('WHATSAPP_WINDOW_CLOSED', 'The customer has not messaged in the last 24 hours — send an approved template instead', 422);
    }
  }

  // A template Meta has not approved is refused here, with its status (whatsappTemplates.js).
  if (template) await require('./whatsappTemplates').assertSendable(workspaceId, template);

  const { accessToken } = secretsOf(integration);
  const { phoneNumberId } = integration.config;
  const record = {
    workspaceId,
    conversationId: conversation.id,
    direction: 'out',
    type: template ? 'template' : 'text',
    body: template ? [template.name, ...(template.params || [])].join(' · ') : text,
    templateName: template ? template.name : null,
    sentByUserId: req && req.user ? req.user.id : null,
    orderId,
  };

  try {
    const sent = template
      ? await cloud.sendTemplate(phoneNumberId, accessToken, phoneNormalized, template)
      : await cloud.sendText(phoneNumberId, accessToken, phoneNormalized, text);
    const message = await db.WhatsappMessage.create({ ...record, waMessageId: sent.waMessageId, status: 'sent' });
    // A teammate typing in the conversation takes it over from the bot.
    await conversation.update({ lastMessageAt: new Date(), lastMessagePreview: (record.body || '').slice(0, 300), ...(record.sentByUserId && !template ? { botPausedAt: new Date() } : {}) });
    inboxEvents.publish(workspaceId, { conversationId: conversation.id, reason: 'message_out' });
    return message;
  } catch (err) {
    await db.WhatsappMessage.create({ ...record, status: 'failed', error: String(err.message).slice(0, 500) });
    if (err.code === 'WHATSAPP_AUTH_FAILED') await integration.update({ status: 'error', lastError: String(err.message).slice(0, 500) });
    require('../notifications/integrationAlerts').whatsapp(workspaceId, err);
    throw err;
  }
}

async function listConversations(workspaceId, { status, search, limit = 50, before } = {}) {
  const where = { workspaceId };
  if (status) where.status = status;
  if (search) where[Op.or] = [{ phoneNormalized: { [Op.iLike]: `%${search.replace(/\D/g, '')}%` } }, { customerName: { [Op.iLike]: `%${search}%` } }];
  if (before) where.lastMessageAt = { [Op.lt]: new Date(before) };
  const rows = await db.WhatsappConversation.findAll({ where, order: [['lastMessageAt', 'DESC NULLS LAST']], limit });
  return {
    conversations: rows.map((c) => ({
      id: c.id,
      phone: c.phoneNormalized,
      customerName: c.customerName,
      customerId: c.customerId,
      status: c.status,
      unreadCount: c.unreadCount,
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      canReply: Boolean(c.lastInboundAt && Date.now() - new Date(c.lastInboundAt).getTime() < WINDOW_MS),
    })),
    nextCursor: rows.length === limit && rows[rows.length - 1].lastMessageAt ? rows[rows.length - 1].lastMessageAt.toISOString() : null,
  };
}

async function getConversation(workspaceId, conversationId) {
  const c = await db.WhatsappConversation.findOne({ where: { id: conversationId, workspaceId } });
  if (!c) throw new NotFoundError('Conversation');
  return c;
}

/** Messages oldest → newest; opening a conversation marks it read. */
async function listMessages(workspaceId, conversationId, { limit = 100, before } = {}) {
  const conversation = await getConversation(workspaceId, conversationId);
  const where = { conversationId };
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.WhatsappMessage.findAll({ where, order: [['createdAt', 'DESC']], limit });
  if (conversation.unreadCount) await conversation.update({ unreadCount: 0 });
  return {
    messages: rows.reverse().map((m) => ({ id: m.id, direction: m.direction, type: m.type, body: m.body, templateName: m.templateName, status: m.status, error: m.error, sentByBot: m.sentByBot, createdAt: m.createdAt })),
    nextCursor: rows.length === limit ? rows[0].createdAt.toISOString() : null,
  };
}

async function setConversationStatus(workspaceId, conversationId, status) {
  const c = await getConversation(workspaceId, conversationId);
  await c.update({ status });
  inboxEvents.publish(workspaceId, { conversationId: c.id, reason: 'conversation' });
  return { id: c.id, status: c.status };
}

// ---------------------------------------------------------------------------
// Webhook (Meta → us)
// ---------------------------------------------------------------------------

// Compared as digests, so the time taken says nothing about how much of the token matched.
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest();
const sameToken = (given, expected) => Boolean(given && expected) && crypto.timingSafeEqual(sha256(given), sha256(expected));

async function verifyWebhookSubscription(workspaceId, { mode, token, challenge }) {
  const integration = await getIntegration(workspaceId);
  if (!integration || mode !== 'subscribe' || typeof token !== 'string' || !sameToken(token, (integration.config || {}).verifyToken)) return null;
  return challenge;
}

/** X-Hub-Signature-256 = sha256 HMAC of the raw body with the Meta app secret. */
async function verifyWebhookSignature(workspaceId, rawBody, header) {
  const integration = await getIntegration(workspaceId);
  if (!integration) return false;
  const { appSecret } = secretsOf(integration);
  if (!appSecret || !rawBody || typeof header !== 'string') return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.replace(/^sha256=/, '');
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const STATUS_RANK = { sent: 1, delivered: 2, read: 3, failed: 4 };

async function handleWebhook(workspaceId, payload) {
  const result = { messages: 0, statuses: 0, ignored: 0 };
  const integration = await getIntegration(workspaceId);
  const ownNumber = integration && integration.config ? String(integration.config.phoneNumberId || '') : '';
  for (const entry of (payload && payload.entry) || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      // A template approved, rejected or paused in Meta (whatsappTemplates.js).
      if (change.field === 'message_template_status_update') {
        await require('./whatsappTemplates').onStatusUpdate(workspaceId, value);
        continue;
      }
      // Meta sends every number of an app to the same callback URL: messages and statuses
      // count here only for the number this store connected. Another number's (a second
      // store on the same app) are logged and dropped, and Meta still gets its 200.
      const phoneNumberId = value.metadata && value.metadata.phone_number_id ? String(value.metadata.phone_number_id) : '';
      if (!ownNumber || phoneNumberId !== ownNumber) {
        const count = (value.messages || []).length + (value.statuses || []).length;
        if (count > 0) {
          logger.warn(`[whatsapp.webhook] ${workspaceId}: ignored ${count} message(s)/status(es) for phone number id "${phoneNumberId || 'none'}", not the store's connected number`);
        }
        result.ignored += count;
        continue;
      }
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));

      for (const msg of value.messages || []) {
        const phoneNormalized = normalizePhone(msg.from);
        if (!phoneNormalized) continue;
        if (msg.id && (await db.WhatsappMessage.findOne({ where: { workspaceId, waMessageId: msg.id }, attributes: ['id'] }))) continue;
        const conversation = await upsertConversation(workspaceId, phoneNormalized, { customerName: names[msg.from] });
        const body = msg.type === 'text' ? msg.text && msg.text.body : msg.type === 'button' ? msg.button && msg.button.text : msg.type === 'interactive' ? JSON.stringify(msg.interactive) : `[${msg.type}]`;
        const at = msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date();
        const inbound = await db.WhatsappMessage.create({ workspaceId, conversationId: conversation.id, direction: 'in', waMessageId: msg.id || null, type: ['text', 'button', 'interactive'].includes(msg.type) ? 'text' : msg.type || 'other', body, status: 'received' });
        await conversation.update({
          lastMessageAt: at,
          lastInboundAt: at,
          lastMessagePreview: (body || '').slice(0, 300),
          unreadCount: conversation.unreadCount + 1,
          status: 'open',
        });
        // A tap on "Confirm order" / "Cancel" confirms or cancels the order (quickReplyConfirmation.js).
        await require('./quickReplyConfirmation').enqueue(workspaceId, msg, phoneNormalized);
        // STOP withdraws marketing consent (optOut.js).
        await require('./optOut').handleInbound(workspaceId, msg, phoneNormalized);
        // A typed message gets the customer service bot's answer when AI is on and the store has the bot on (bot/botService.js).
        if (msg.type === 'text') await require('./bot/botService').enqueue(workspaceId, conversation.id, inbound.id);
        inboxEvents.publish(workspaceId, { conversationId: conversation.id, reason: 'message_in' });
        result.messages += 1;
      }

      for (const st of value.statuses || []) {
        const message = await db.WhatsappMessage.findOne({ where: { workspaceId, waMessageId: st.id } });
        if (!message) continue;
        if ((STATUS_RANK[st.status] || 0) > (STATUS_RANK[message.status] || 0)) {
          const error = st.errors && st.errors[0] ? `${st.errors[0].code}: ${st.errors[0].title || st.errors[0].message || ''}` : null;
          await message.update({ status: st.status, error: error ? error.slice(0, 500) : message.error });
          inboxEvents.publish(workspaceId, { conversationId: message.conversationId, reason: 'status' });
        }
        result.statuses += 1;
      }
    }
  }
  return result;
}

module.exports = {
  PROVIDER,
  getIntegration,
  integrationView,
  connect,
  disconnect,
  sendMessage,
  listConversations,
  listMessages,
  setConversationStatus,
  verifyWebhookSubscription,
  verifyWebhookSignature,
  handleWebhook,
};
