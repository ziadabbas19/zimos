'use strict';

const env = require('../../config/env');
const cloud = require('../whatsapp/whatsappCloud');

/**
 * ZIMOS's own WhatsApp number (WHATSAPP_PROVIDER=cloud): the one-time codes
 * the platform sends — checkout phone checks, phone verification, two-step
 * sign-in. A store's own number (Inbox, automations) is not this; it lives in
 * modules/whatsapp. See PLATFORM_WHATSAPP.md for the settings and the
 * template to create at Meta.
 *
 * A code goes out as the approved authentication template (body {{1}} = the
 * code, plus the copy-code button Meta requires); a ready text (`data.body`)
 * as plain text, which Meta only delivers inside a 24-hour window. A
 * teammate's notification (merchantNotificationService, the `whatsapp`
 * channel) goes out as the approved alert template: {{1}} title, {{2}} text,
 * {{3}} the dashboard link. Anything else is refused, so the caller falls
 * back to SMS. The phone number id
 * `sandbox` answers locally (refused in production), like a store's.
 */

function config() {
  return {
    phoneNumberId: (process.env.WHATSAPP_PLATFORM_PHONE_NUMBER_ID || '').trim(),
    token: (process.env.WHATSAPP_PLATFORM_TOKEN || '').trim(),
    codeTemplate: (process.env.WHATSAPP_CODE_TEMPLATE || 'zimos_code').trim(),
    languages: {
      ar: (process.env.WHATSAPP_CODE_LANG_AR || 'ar').trim(),
      en: (process.env.WHATSAPP_CODE_LANG_EN || 'en_US').trim(),
    },
    alertTemplate: (process.env.WHATSAPP_ALERT_TEMPLATE || 'zimos_alert').trim(),
    alertLanguage: (process.env.WHATSAPP_ALERT_LANG || 'ar').trim(),
  };
}

// A template parameter may not hold new lines, tabs or long runs of spaces (Meta refuses it).
const param = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max) || '—';

async function send({ to, template, data = {} }) {
  const { phoneNumberId, token, codeTemplate, languages, alertTemplate, alertLanguage } = config();
  if (!phoneNumberId || !token) {
    throw new Error('The platform WhatsApp number is not configured (WHATSAPP_PLATFORM_PHONE_NUMBER_ID / WHATSAPP_PLATFORM_TOKEN)');
  }
  const recipient = String(to).replace(/^\+/, '');
  if (data.code) {
    const code = String(data.code);
    return cloud.sendTemplate(phoneNumberId, token, recipient, {
      name: codeTemplate,
      language: data.locale === 'en' ? languages.en : languages.ar,
      params: [code],
      urlButtonParam: code,
    });
  }
  if (template === 'merchant_notification') {
    const link = `${env.frontendUrl.replace(/\/$/, '')}${data.link || ''}`;
    return cloud.sendTemplate(phoneNumberId, token, recipient, {
      name: alertTemplate,
      language: alertLanguage,
      params: [param(data.title, 120), param(data.body, 600), link],
    });
  }
  if (typeof data.body === 'string' && data.body.trim()) return cloud.sendText(phoneNumberId, token, recipient, data.body);
  throw new Error(`No WhatsApp message is set up for "${template}"`);
}

/** Whether the platform number has what a send needs (its id and token); says nothing about Meta's answer. */
function configured() {
  const { phoneNumberId, token } = config();
  return Boolean(phoneNumberId && token);
}

module.exports = { send, config, configured };
