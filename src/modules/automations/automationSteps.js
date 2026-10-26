'use strict';

const db = require('../../db/models');
const notify = require('../notifications/notify');
const { checkUrl } = require('../webhooks/webhookUrlGuard');
const webhookSender = require('../webhooks/webhookSender');
const customerData = require('../webhooks/customerData');
const { PERMISSIONS } = require('../../core/security/permissions');
const { render } = require('./automationContext');

/**
 * The step types of an automation (SPEC §14.2) and how each one runs.
 *
 *   wait               pause the sequence (handled by the executor, not here)
 *   whatsapp_template  an approved template through the store's WhatsApp number
 *   sms                a text through the SMS provider
 *   email              an email through the email provider
 *   webhook            POST the event to a URL of the merchant's
 *   add_tag            tag the order
 *   set_status         confirm or cancel the order
 *   notify_team        a notification in the dashboard bell
 *
 * A runner returns a short description of what it did (stored on the run row)
 * or throws; a thrown error marks that step failed and the sequence goes on.
 */

const STEP_TYPES = ['wait', 'whatsapp_template', 'sms', 'email', 'webhook', 'add_tag', 'set_status', 'notify_team'];
const WAIT_UNITS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
const MAX_WAIT_MS = 30 * WAIT_UNITS.days;

const waitMs = (step) => Math.min(MAX_WAIT_MS, Math.max(0, Number(step.amount) || 0) * (WAIT_UNITS[step.unit] || WAIT_UNITS.minutes));

/**
 * set_status acts as the store's owner: the confirmation queue and the audit
 * log both need a real person, and "the automation the owner switched on" is
 * the honest answer to "who confirmed this?".
 */
async function systemRequest(workspaceId) {
  const membership = await db.Membership.findOne({
    where: { workspaceId, status: 'active' },
    include: [{ model: db.Role, as: 'role', where: { key: 'owner' } }],
  });
  if (!membership || !membership.userId) throw new Error('the store has no owner to act as');
  return {
    user: { id: membership.userId },
    tenant: { workspaceId, membership, role: membership.role, hasPermission: () => true },
    headers: { 'user-agent': 'zimos-automation' },
    ip: null,
    get: () => undefined,
    viaAutomation: true,
  };
}

const requireOrder = (subject, what) => {
  if (subject.kind !== 'order') throw new Error(`${what} needs an order`);
  return subject.order;
};

// Appended to a marketing SMS that does not already say how to stop.
const STOP_LINE = 'للإيقاف أرسل: إيقاف';

const RUNNERS = {
  async whatsapp_template(step, subject, { workspaceId }) {
    if (!subject.phone) throw new Error('no phone number');
    // Lazy require: whatsappService → orders modules would otherwise be circular.
    const whatsapp = require('../whatsapp/whatsappService');
    await whatsapp.sendMessage(workspaceId, {
      to: subject.phone,
      // Lets the customer's quick-reply to this message find its order.
      orderId: subject.kind === 'order' ? subject.order.id : null,
      template: { name: step.template, language: step.language || 'ar', params: (step.params || []).map((p) => render(p, subject.vars)) },
    });
    return `whatsapp_template ${step.template}`;
  },

  async sms(step, subject, { workspaceId, trigger }) {
    if (!subject.phone) throw new Error('no phone number');
    let body = render(step.body, subject.vars).slice(0, 600);
    // A marketing SMS says how to stop them (SPEC §6.4); a STOP reply is honoured by marketingGuard.
    if (require('./marketingGuard').isMarketing(trigger) && !/stop|إيقاف|ايقاف/i.test(body)) body = `${body.slice(0, 570)}\n${STOP_LINE}`;
    const sent = await notify.sms({ recipient: subject.phone, template: 'automation_sms', data: { body }, workspaceId, orderId: subject.kind === 'order' ? subject.order.id : null });
    if (sent.status !== 'sent') throw new Error(sent.error || 'the SMS provider refused the message');
    return 'sms';
  },

  async email(step, subject, { workspaceId }) {
    if (!subject.email) throw new Error('no email address');
    const sent = await notify.email({
      recipient: subject.email,
      template: 'automation_message',
      data: { subject: render(step.subject, subject.vars).slice(0, 200), body: render(step.body, subject.vars).slice(0, 5000), storeName: subject.vars.store_name },
      workspaceId,
      orderId: subject.kind === 'order' ? subject.order.id : null,
    });
    if (sent.status !== 'sent') throw new Error(sent.error || 'the email provider refused the message');
    return 'email';
  },

  async webhook(step, subject, { workspaceId, trigger, rule }) {
    const url = checkUrl(step.url);
    // The customer's name and the order's links in full only while the
    // teammate who last saved the rule's steps may see customers in full
    // (automation_rules.configured_by_user_id, migration 722) — the rule
    // webhook endpoints follow (webhooks/customerData.js). Unknown: masked.
    const reveals = rule ? (await customerData.revealsByEndpoint(workspaceId, [rule])).get(rule.id) : false;
    const body = JSON.stringify({
      event: trigger,
      automation: { id: rule ? rule.id : null, name: rule ? rule.name : null },
      workspaceId,
      orderId: subject.kind === 'order' ? subject.order.id : null,
      checkoutSessionId: subject.kind === 'checkout' ? subject.session.id : null,
      data: reveals ? subject.vars : customerData.maskAutomationVars(subject.vars),
      sentAt: new Date().toISOString(),
    });
    const result = await webhookSender.send({ url, body, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Zimos-Automations' }, timeoutMs: 10000 });
    if (!result.status || result.status >= 400) throw new Error(result.error || `the URL answered ${result.status}`);
    return `webhook ${result.status}`;
  },

  async add_tag(step, subject) {
    const order = requireOrder(subject, 'add_tag');
    const tag = String(step.tag).trim().slice(0, 40);
    const tags = order.tags || [];
    if (!tags.some((t) => String(t).toLowerCase() === tag.toLowerCase())) await order.update({ tags: [...tags, tag] });
    return `add_tag ${tag}`;
  },

  async set_status(step, subject, { workspaceId, rule }) {
    const order = requireOrder(subject, 'set_status');
    const req = await systemRequest(workspaceId);
    const note = `Automation: ${rule ? rule.name : 'rule'}`;
    if (step.status === 'confirmed') {
      await require('../cod/confirmationService').confirmFromOrder(workspaceId, order.id, { notes: note, channel: 'whatsapp' }, req);
    } else if (step.status === 'cancelled') {
      await require('../orders/orderService').cancelOrder(workspaceId, order.id, { reason: note }, req);
    } else {
      throw new Error(`unsupported status ${step.status}`);
    }
    return `set_status ${step.status}`;
  },

  async notify_team(step, subject, { workspaceId, rule }) {
    const merchantNotifications = require('../notifications/merchantNotificationService');
    const message = render(step.message, subject.vars).slice(0, 500);
    await merchantNotifications.create(workspaceId, {
      type: 'automation',
      title: rule ? rule.name : 'Automation',
      body: message,
      link: subject.kind === 'order' ? `/orders/${subject.order.id}` : '/abandoned-carts',
      data: { message, ruleId: rule ? rule.id : null },
    });
    return 'notify_team';
  },
};

/** Runs one non-wait step. */
function runStep(step, subject, env) {
  const runner = RUNNERS[step.type];
  if (!runner) throw new Error(`unknown step type ${step.type}`);
  return runner(step, subject, env);
}

module.exports = { STEP_TYPES, WAIT_UNITS, waitMs, runStep, systemRequest, PERMISSIONS };
