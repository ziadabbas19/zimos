'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const db = require('../../db/models');
const emailTemplates = require('./emailTemplates');
const brevoEmailProvider = require('./brevoEmailProvider');
const twilioSmsProvider = require('./twilioSmsProvider');
const platformWhatsapp = require('./platformWhatsapp');

// Delivery status (deliveryStatus/, DELIVERY_STATUS_ENABLED): the suppression list checked before an
// email, the console provider's simulated reports and the Twilio statusCallback. Lazy: they reach back here.
const deliveryStatus = () => ({
  on: require('./deliveryStatus/gate').deliveryStatusOn(),
  suppressions: require('./deliveryStatus/suppressions'),
  simulate: require('./deliveryStatus/simulate'),
  webhooks: require('./deliveryStatus/webhookRoutes'),
});
const consoleMessageId = () => `console-${require('crypto').randomUUID()}`;

// Minimal SMS bodies. OTP flows pass { code } (and, for the sign-up code,
// { minutes, locale }); anything else falls back to a terse template-name +
// data dump so nothing sends blank.
function smsBody(template, data = {}) {
  // A ready text (automations' SMS step): sent as written.
  if (typeof data.body === 'string' && data.body.trim()) return data.body;
  if (data.code) {
    const minutes = Number(data.minutes) || 5;
    if (data.locale === 'ar') return `رمز التحقق في Zimos: ${data.code}. صالح لمدة ${minutes} دقائق.`;
    return `Your Zimos verification code is ${data.code}. It expires in ${minutes} minutes.`;
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
// or `brevo`. The real provider call retries transient failures (see
// core/utils/retry). Every send — success or failure, with its attempt
// count — is recorded in notification_logs; a failed send never throws up
// to the caller, so the triggering action still succeeds.

// What the console provider logs. A one-time code is a credential: in
// production it never reaches a log line (it may in development and tests,
// where the console is the only inbox).
function loggable(data) {
  if (!env.isProduction || !data || typeof data !== 'object' || !('code' in data)) return data;
  return { ...data, code: '[REDACTED]' };
}

// A store's emails to its own shoppers (the rest are the platform's to its
// merchants). Their sender name is EMAIL_FROM_NAME unless the data carries
// one: the order emails pass the store's (orderEmailSender.senderFor), the
// others don't. While the store hides the platform branding
// (storefront/platformBranding.js) every one of them takes the store's
// sender name and Reply-To, so the shopper never reads the platform's name.
const SHOPPER_TEMPLATES = new Set(['order_email', 'automation_message', 'back_in_stock', 'question_answered', 'gift_card', 'shopper_login_code']);

async function storeSender({ template, data, workspaceId }) {
  if (!workspaceId || !SHOPPER_TEMPLATES.has(template) || (data && data.fromName)) return null;
  try {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
    if (!(await require('../storefront/platformBranding').isHidden(workspace))) return null;
    return await require('./orderEmailSender').senderFor(workspaceId);
  } catch (err) {
    // The email still goes, under the platform's name as before.
    logger.warn(`[notification:email] ${template}: the store's sender name could not be read: ${err.message}`);
    return null;
  }
}

// `orderId`: a message to a customer about an order — logged with it and its line, for the order's timeline.
// `providerMessageId`: the provider's id for the message, so its status webhook finds the row (deliveryStatus/).
async function persist({ workspaceId, channel, provider, recipient, template, status, error, attempts, orderId = null, subject = null, providerMessageId = null, deliveryStatus: delivery = null, statusReason = null }) {
  await db.NotificationLog.create({
    workspaceId,
    channel,
    provider,
    recipient,
    template,
    status,
    error,
    attempts,
    orderId: orderId || null,
    subject: orderId && subject ? String(subject).replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    providerMessageId: providerMessageId ? String(providerMessageId).slice(0, 255) : null,
    deliveryStatus: delivery,
    statusReason,
  });
}

async function sendEmail({ recipient, template, data, workspaceId = null, orderId = null }) {
  const provider = env.notifications.emailProvider;
  // The console's sender name, signature and footer links (PLATFORM_SETTINGS_ENABLED); null = as before. Never throws.
  const branding = await require('../platformSettings/platformSettingsService').emailBranding();
  const { subject, html, text } = emailTemplates.render(template, data, branding);

  // An address that hard-bounced or complained gets nothing more (account and security emails excepted).
  const delivery = deliveryStatus();
  const suppressed = delivery.on ? await delivery.suppressions.blocking({ workspaceId, recipient, template }) : null;
  if (suppressed) {
    const error = `Suppressed: ${suppressed.reason}`;
    logger.info(`[notification:email] ${template} not sent: the address is suppressed (${suppressed.reason})`);
    await persist({ workspaceId, channel: 'email', provider, recipient, template, status: 'failed', error, attempts: 0, orderId, subject, deliveryStatus: 'suppressed', statusReason: suppressed.reason });
    return { status: 'suppressed', error, subject, attempts: 0 };
  }

  let status = 'sent';
  let error = null;
  let attempts = 1;
  let messageId = null;
  try {
    if (provider === 'console') {
      messageId = consoleMessageId();
      logger.info(`[notification:email] ${template} -> ${recipient} :: ${subject}`, { data: loggable(data) });
    } else if (provider === 'brevo') {
      // A store's own sender name first; on the platform's own emails only, the console's; else EMAIL_FROM_NAME.
      // A store's email to its shopper never takes the console's name, so a shopper never sees it on a store's email.
      const platformEmail = emailTemplates.PLATFORM_TEMPLATES.has(template);
      const own = await storeSender({ template, data, workspaceId });
      const fromName =
        data && data.fromName ? String(data.fromName).slice(0, 100) : own ? own.fromName : branding && platformEmail ? branding.senderName : undefined;
      const replyTo = data && data.replyTo ? String(data.replyTo) : own && own.replyTo ? own.replyTo : undefined;
      const sent = await brevoEmailProvider.sendEmail({ to: recipient, subject, html, text, fromName, replyTo });
      attempts = sent.attempts || attempts;
      messageId = sent.messageId ? String(sent.messageId).trim().replace(/^<|>$/g, '') : null;
    } else {
      throw new Error(`Email provider "${provider}" is not configured`);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    attempts = err.attempts || attempts;
    logger.error(`[notification:email] ${template} -> ${recipient} failed after ${attempts} attempt(s): ${err.message}`);
  }

  await persist({ workspaceId, channel: 'email', provider, recipient, template, status, error, attempts, orderId, subject, providerMessageId: status === 'sent' ? messageId : null });
  if (status === 'sent' && provider === 'console') delivery.simulate.afterConsoleSend({ channel: 'email', recipient, messageId });
  return { status, error, subject, attempts };
}

async function sendChannel(channel, provider, { recipient, template, data, workspaceId = null, orderId = null }) {
  let status = 'sent';
  let error = null;
  let attempts = 1;
  let messageId = null;
  try {
    if (provider === 'console') {
      messageId = consoleMessageId();
      // Nothing leaves the server: logged, as before.
      logger.info(`[notification:${channel}] ${template} -> ${recipient}`, { data: loggable(data) });
    } else if (channel === 'whatsapp' && provider === 'cloud') {
      // ZIMOS's own number (PLATFORM_WHATSAPP.md).
      await platformWhatsapp.send({ to: recipient, template, data });
    } else if (channel === 'sms' && provider === 'twilio') {
      const sent = await twilioSmsProvider.sendSms({ to: recipient, body: smsBody(template, data), statusCallback: deliveryStatus().webhooks.twilioStatusCallbackUrl() });
      attempts = sent.attempts || attempts;
      messageId = sent.sid || null;
    } else {
      throw new Error(`Notification provider "${provider}" is not configured with credentials`);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    attempts = err.attempts || attempts;
    logger.error(`[notification:${channel}] ${template} -> ${recipient} failed after ${attempts} attempt(s): ${err.message}`);
  }

  await persist({ workspaceId, channel, provider, recipient, template, status, error, attempts, orderId, subject: orderId ? smsBody(template, data) : null, providerMessageId: status === 'sent' ? messageId : null });
  if (status === 'sent' && provider === 'console') deliveryStatus().simulate.afterConsoleSend({ channel, recipient, messageId });
  return { status, error, attempts };
}

const notify = {
  email: (opts) => sendEmail(opts),
  sms: (opts) => sendChannel('sms', env.notifications.smsProvider, opts),
  whatsapp: (opts) => sendChannel('whatsapp', env.notifications.whatsappProvider, opts),
};

module.exports = notify;
