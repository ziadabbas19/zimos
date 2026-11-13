'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { isTransient } = require('../../core/utils/retry');

/**
 * Where a campaign email goes out. Every provider takes one message and
 * answers { messageId } or throws an error with `transient` set when trying
 * again later may work (timeout, 429, 5xx) — the sender's retry schedule
 * decides when (campaignSender.js), never the provider.
 *
 *   send({ to, fromName, fromAddress, replyTo, subject, html, text, headers, tags })
 *
 *   brevo  the platform's transactional email account (notifications/brevoEmailProvider.js,
 *          BREVO_API_KEY), one attempt per call
 *   log    sends nothing: one info line without the address (local and dev)
 *
 * Another provider (Resend, SES, SMTP) is one more entry with the same `send`;
 * EMAIL_CAMPAIGNS_PROVIDER picks it.
 */

const PROVIDERS = {
  brevo: {
    name: 'brevo',
    configured: () => Boolean(env.notifications.brevo.apiKey),
    async send(message) {
      try {
        const sent = await require('../notifications/brevoEmailProvider').sendEmail({ ...message, retry: false });
        return { messageId: sent.messageId ? String(sent.messageId).trim().replace(/^<|>$/g, '') : null };
      } catch (err) {
        err.transient = isTransient(err);
        throw err;
      }
    },
  },
  log: {
    name: 'log',
    configured: () => true,
    async send(message) {
      const messageId = `log-${require('crypto').randomUUID()}`;
      // The address stays out of the log at info level: the campaign and the message id say which one it was.
      logger.info(`[emailCampaigns:log] would send "${String(message.subject).slice(0, 80)}" (${message.tags ? message.tags.join(',') : ''}) as ${messageId}`);
      return { messageId };
    },
  },
};

/** The provider in use, or null when EMAIL_CAMPAIGNS_PROVIDER names one that doesn't exist. */
function current() {
  return PROVIDERS[env.emailCampaigns.provider] || null;
}

/** Can campaigns be sent right now: a known provider with its credentials. */
const ready = () => Boolean(current() && current().configured());

module.exports = { PROVIDERS, current, ready };
