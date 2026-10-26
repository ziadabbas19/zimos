'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');

/**
 * A person who answers a WhatsApp message with STOP (or an Arabic form of it)
 * no longer gets marketing messages from the store: the phone is recorded in
 * marketing_opt_outs — whether or not it belongs to a customer, an abandoned
 * checkout has none — and a customer's marketingConsent goes false.
 * Recovery, review-request and lead automations skip it
 * (automations/marketingGuard.js).
 */

const normalise = (text) =>
  String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/[.!؟?]+$/g, '')
    .replace(/\s+/g, ' ');
const STOP_WORDS = new Set(['stop', 'unsubscribe', 'cancel', 'الغاء', 'الغاء الاشتراك', 'ايقاف', 'توقف', 'لا ترسل'].map(normalise));

async function handleInbound(workspaceId, msg, phoneNormalized) {
  try {
    const text = msg.type === 'text' && msg.text ? msg.text.body : msg.type === 'button' && msg.button ? msg.button.text : null;
    if (!text || !STOP_WORDS.has(normalise(text))) return { optOut: false };
    // A reply quoting an order message is never an opt-out; "إلغاء" on the confirmation message
    // cancels that order (quickReplyConfirmation.js).
    const quotesOrder = msg.context && msg.context.id ? await db.WhatsappMessage.count({ where: { workspaceId, waMessageId: msg.context.id, orderId: { [Op.ne]: null } } }) : 0;
    if (quotesOrder) return { optOut: false };

    const word = String(text).slice(0, 40);
    const [, created] = await db.MarketingOptOut.findOrCreate({
      where: { workspaceId, phoneNormalized },
      defaults: { workspaceId, phoneNormalized, source: 'whatsapp', word },
    });
    const [updated] = await db.Customer.update({ marketingConsent: false }, { where: { workspaceId, phoneNormalized, marketingConsent: true } });
    if (created || updated) {
      await recordAudit({ workspaceId, actorUserId: null, action: 'customer.marketing_consent.withdrawn', entityType: 'Customer', entityId: null, metadata: { phoneNormalized, via: 'whatsapp', word } });
    }
    return { optOut: true };
  } catch (err) {
    logger.error(`[whatsapp] opt-out handling failed for ${workspaceId}: ${err.message}`);
    return { optOut: false };
  }
}

module.exports = { handleInbound, STOP_WORDS, normalise };
