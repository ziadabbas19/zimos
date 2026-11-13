'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const suppressions = require('../notifications/deliveryStatus/suppressions');

/**
 * What the provider reports about a campaign email, after it was sent. The
 * same signed Brevo webhook as the store's other emails
 * (notifications/deliveryStatus/webhookRoutes.js) hands every event it could
 * not match there to `brevoEvent` here, matched by the provider's message id
 * on email_campaign_recipients.
 *
 *   delivered                     → delivered
 *   hard_bounce, invalid_email    → bounced, and the address is suppressed for the store
 *   spam, complaint               → complained, suppressed, and unsubscribed from marketing
 *   blocked, error                → undelivered
 *   opened, unique_opened, proxy_open → opened (first time only)
 *   click                         → clicked (first time only)
 *   unsubscribed                  → unsubscribed from marketing
 *   soft_bounce, deferred         → nothing (the provider keeps trying)
 *
 * delivery_status only moves up (delivered → undelivered | bounced →
 * complained), and every counter moves in the statement that changed the row,
 * so a repeated or late event changes nothing twice.
 */

const RANK = { delivered: 1, undelivered: 2, bounced: 2, complained: 3 };
const STATUS = {
  delivered: { status: 'delivered', counter: 'delivered_count' },
  hard_bounce: { status: 'bounced', counter: 'bounced_count', suppress: 'hard_bounce' },
  invalid_email: { status: 'bounced', counter: 'bounced_count', suppress: 'hard_bounce' },
  spam: { status: 'complained', counter: 'complained_count', suppress: 'complaint', optOut: true },
  complaint: { status: 'complained', counter: 'complained_count', suppress: 'complaint', optOut: true },
  blocked: { status: 'undelivered' },
  error: { status: 'undelivered' },
};
const FIRST = {
  opened: { column: 'opened_at', counter: 'opened_count' },
  unique_opened: { column: 'opened_at', counter: 'opened_count' },
  proxy_open: { column: 'opened_at', counter: 'opened_count' },
  click: { column: 'clicked_at', counter: 'clicked_count' },
};

// Outside production the log provider's ids match too, so the path can be tried without Brevo.
const providers = () => (env.isProduction ? ['brevo'] : ['brevo', 'log']);
const stripBrackets = (id) => (id ? String(id).trim().replace(/^<|>$/g, '') : null);

async function findRecipient(messageId, email) {
  const where = { providerMessageId: String(messageId).slice(0, 255), provider: providers() };
  const row = await db.EmailCampaignRecipient.findOne({ where, attributes: ['id', 'campaignId', 'workspaceId', 'customerId', 'email'] });
  if (!row) return null;
  // The event's address has to be the one the message went to.
  if (email && suppressions.normalize(email) !== row.email) return null;
  return row;
}

async function moveStatus(row, map) {
  const lower = Object.keys(RANK).filter((s) => RANK[s] < RANK[map.status]);
  const counter = map.counter
    ? `, c AS (UPDATE email_campaigns SET ${map.counter} = ${map.counter} + 1, updated_at = NOW() WHERE id IN (SELECT campaign_id FROM r) RETURNING id)`
    : '';
  const [moved] = await db.sequelize.query(
    `WITH r AS (
       UPDATE email_campaign_recipients
          SET delivery_status = :status${map.status === 'delivered' ? ', delivered_at = NOW()' : ''}
        WHERE id = :id AND status = 'sent' AND (delivery_status IS NULL${lower.length ? ' OR delivery_status IN (:lower)' : ''})
        RETURNING campaign_id)${counter}
     SELECT count(*)::int AS n FROM r`,
    { replacements: { id: row.id, status: map.status, lower }, type: QueryTypes.SELECT }
  );
  return moved && moved.n > 0 ? 'updated' : 'unchanged';
}

async function firstTime(row, map) {
  const [moved] = await db.sequelize.query(
    `WITH r AS (
       UPDATE email_campaign_recipients SET ${map.column} = NOW()
        WHERE id = :id AND status = 'sent' AND ${map.column} IS NULL
        RETURNING campaign_id),
     c AS (UPDATE email_campaigns SET ${map.counter} = ${map.counter} + 1, updated_at = NOW() WHERE id IN (SELECT campaign_id FROM r) RETURNING id)
     SELECT count(*)::int AS n FROM r`,
    { replacements: { id: row.id }, type: QueryTypes.SELECT }
  );
  return moved && moved.n > 0 ? 'updated' : 'unchanged';
}

/**
 * One Brevo event, if it is about a campaign email: 'updated' | 'unchanged';
 * null when no campaign email has that message id (the caller answers it).
 */
async function brevoEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const name = String(e.event || '').toLowerCase();
  const messageId = stripBrackets(e['message-id'] || e.messageId || e.message_id);
  if (!messageId) return null;
  const row = await findRecipient(messageId, typeof e.email === 'string' ? e.email : null);
  if (!row) return null;

  if (FIRST[name]) return firstTime(row, FIRST[name]);
  if (name === 'unsubscribed') {
    await require('./campaignUnsubscribe').unsubscribeRecipient(row, { via: 'provider' });
    return 'updated';
  }
  const map = STATUS[name];
  if (!map) return 'unchanged';
  const outcome = await moveStatus(row, map);
  if (outcome === 'updated' && map.suppress) {
    try {
      await suppressions.suppress({ workspaceId: row.workspaceId, email: row.email, reason: map.suppress, source: 'brevo', detail: [e.event, e.reason].filter(Boolean).join(': ') });
    } catch (err) {
      logger.error(`[emailCampaigns] could not suppress recipient ${row.id}: ${err.message}`);
    }
  }
  if (outcome === 'updated' && map.optOut) await require('./campaignUnsubscribe').unsubscribeRecipient(row, { via: 'complaint' });
  return outcome;
}

module.exports = { brevoEvent, STATUS, FIRST, RANK };
