'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const db = require('../../db/models');
const emailTemplates = require('./emailTemplates');
const brevoEmailProvider = require('./brevoEmailProvider');
const twilioSmsProvider = require('./twilioSmsProvider');

// Minimal SMS bodies. OTP flows pass { code }; anything else falls back to a
// terse template-name + data dump so nothing sends blank.
function smsBody(template, data = {}) {
  if (data.code) {
    return `Your Store Builder verification code is ${data.code}. It expires in 5 minutes.`;
  }
  const extra = Object.entries(data)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
  return extra ? `${template} — ${extra}` : template;
}

// Provider-independent sending. Callers use notify.email/sms/whatsapp and
// never touch a vendor SDK. Email is rendered from a template (subject +
// HTML + text, with a shared footer) then sent via whichever provider
// EMAIL_PROVIDER selects: `console` (logs + notification_logs, the default)
// or `brevo`. Every send is recorded in notification_logs.

async function persist({ workspaceId, channel, provider, recipient, template, status, error }) {
  await db.NotificationLog.create({ workspaceId, channel, provider, recipient, template, status, error });
}

async function sendEmail({ recipient, template, data, workspaceId = null }) {
  const provider = env.notifications.emailProvider;
  const { subject, html, text } = emailTemplates.render(template, data);

  let status = 'sent';
  let error = null;
  try {
    if (provider === 'console') {
      logger.info(`[notification:email] ${template} -> ${recipient} :: ${subject}`, { data });
    } else if (provider === 'brevo') {
      await brevoEmailProvider.sendEmail({ to: recipient, subject, html, text });
    } else {
      throw new Error(`Email provider "${provider}" is not configured`);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    logger.error(`[notification:email] ${template} -> ${recipient} failed: ${err.message}`);
  }

  await persist({ workspaceId, channel: 'email', provider, recipient, template, status, error });
  return { status, error, subject };
}

async function sendChannel(channel, provider, { recipient, template, data, workspaceId = null }) {
  let status = 'sent';
  let error = null;
  try {
    if (provider === 'console') {
      logger.info(`[notification:${channel}] ${template} -> ${recipient}`, { data });
    } else if (channel === 'sms' && provider === 'twilio') {
      await twilioSmsProvider.sendSms({ to: recipient, body: smsBody(template, data) });
    } else {
      throw new Error(`Notification provider "${provider}" is not configured with credentials`);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    logger.error(`[notification:${channel}] ${template} -> ${recipient} failed: ${err.message}`);
  }

  await persist({ workspaceId, channel, provider, recipient, template, status, error });
  return { status, error };
}

const notify = {
  email: (opts) => sendEmail(opts),
  sms: (opts) => sendChannel('sms', env.notifications.smsProvider, opts),
  whatsapp: (opts) => sendChannel('whatsapp', env.notifications.whatsappProvider, opts),
};

module.exports = notify;
