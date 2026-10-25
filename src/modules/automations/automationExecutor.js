'use strict';

const db = require('../../db/models');
const queue = require('../../core/queue');
const logger = require('../../core/utils/logger');
const context = require('./automationContext');
const steps = require('./automationSteps');
const recoveryCoupon = require('./recoveryCoupon');
const marketingGuard = require('./marketingGuard');

/**
 * Runs automation rules as ordered sequences (SPEC §14.2).
 *
 * trigger → for each active rule: conditions → an execution → its steps in
 * order. A `wait` step parks the execution and queues `automations.resume`
 * with that delay; when it resumes, the sequence stops if the order (or lost
 * checkout) has moved on since it started — a customer who bought after an
 * abandoned-cart message gets no second reminder. Every step writes one
 * automation_runs row: sent, failed or skipped.
 */

const RESUME_JOB = 'automations.resume';

// Steps that message the customer (a webhook or a tag is not a message).
const MESSAGE_STEPS = new Set(['whatsapp_template', 'sms', 'email']);
// Steps that carry the customer's details anywhere: never run for a locked
// order or checkout (orders/orderLock), not even tried.
const CUSTOMER_DATA_STEPS = new Set([...MESSAGE_STEPS, 'webhook', 'notify_team']);

// A trigger that is really another event plus a delay: "ask for a review N
// days after delivery" listens to order.delivered and waits first.
const DERIVED_TRIGGERS = { 'order.delivered': [{ trigger: 'review.request', defaultDelayDays: 3 }] };

const logRun = (execution, fields) =>
  db.AutomationRun.create({
    workspaceId: execution.workspaceId,
    ruleId: execution.ruleId,
    trigger: execution.trigger,
    orderId: execution.orderId,
    executionId: execution.id,
    ...fields,
    detail: fields.detail ? String(fields.detail).slice(0, 500) : null,
  });

function loadSubject(workspaceId, { orderId, checkoutSessionId, subscriptionId, customerId }) {
  if (orderId) return context.loadOrderSubject(workspaceId, orderId);
  if (checkoutSessionId) return context.loadCheckoutSubject(workspaceId, checkoutSessionId);
  if (customerId) return context.loadCustomerSubject(workspaceId, customerId);
  return null;
}

// An execution keeps its order or checkout in columns; a subscription or a
// customer (no column of its own) in context.target.
const targetOfExecution = (execution) => ({
  orderId: execution.orderId,
  checkoutSessionId: execution.checkoutSessionId,
  ...((execution.context && execution.context.target) || {}),
});

async function finish(execution, status) {
  await execution.update({ status, finishedAt: new Date(), resumeAt: null });
}

/** Runs the execution from its next step until it ends or waits. */
async function advance(execution, { resumed = false } = {}) {
  const subject = await loadSubject(execution.workspaceId, targetOfExecution(execution));
  if (!subject) {
    await logRun(execution, { status: 'skipped', detail: 'the order no longer exists' });
    return finish(execution, 'stopped');
  }
  const ctx = execution.context || {};
  if (resumed && ctx.stopOnStatusChange !== false && ctx.signature && subject.signature !== ctx.signature) {
    await logRun(execution, { status: 'skipped', stepIndex: execution.nextStepIndex, detail: 'stopped: the status changed while waiting' });
    return finish(execution, 'stopped');
  }
  if (ctx.couponCode) subject.vars.coupon_code = ctx.couponCode;
  const rule = execution.ruleId ? await db.AutomationRule.findByPk(execution.ruleId) : null;
  if (resumed && (!rule || !rule.isActive)) {
    await logRun(execution, { status: 'skipped', stepIndex: execution.nextStepIndex, detail: 'stopped: the automation was switched off' });
    return finish(execution, 'stopped');
  }

  const list = execution.steps || [];
  // Asked once per run of the steps, so a top-up while the sequence waited opens it again.
  const locked = await require('../orders/orderLock').subjectLocked(execution.workspaceId, subject);
  for (let i = execution.nextStepIndex; i < list.length; i += 1) {
    const step = list[i];
    if (locked && CUSTOMER_DATA_STEPS.has(step.type)) {
      await logRun(execution, { status: 'skipped', stepIndex: i, stepType: step.type, detail: 'skipped: the order is locked (its customer details are hidden)' });
      await execution.update({ nextStepIndex: i + 1 });
      continue;
    }
    if (step.type === 'wait') {
      const delayMs = steps.waitMs(step);
      await execution.update({ status: 'waiting', nextStepIndex: i + 1, resumeAt: new Date(Date.now() + delayMs) });
      await queue.add('notifications', RESUME_JOB, { executionId: execution.id }, { workspaceId: execution.workspaceId, delayMs, dedupeKey: `aut:${execution.id}:${i}` });
      return execution;
    }
    // Checked before every message, not only at the start: a STOP during a wait counts.
    if (MESSAGE_STEPS.has(step.type) && marketingGuard.isMarketing(execution.trigger)) {
      const refused = await marketingGuard.refusal(execution.workspaceId, subject.phone, subject.email);
      if (refused) {
        await logRun(execution, { status: 'skipped', stepIndex: i, stepType: step.type, detail: `stopped: ${refused}` });
        return finish(execution, 'stopped');
      }
    }
    try {
      const detail = await steps.runStep(step, recoveryCoupon.forStep(subject, step, ctx.couponCode, list), { workspaceId: execution.workspaceId, trigger: execution.trigger, rule });
      await logRun(execution, { status: 'sent', stepIndex: i, stepType: step.type, detail });
      if (MESSAGE_STEPS.has(step.type)) await require('./recoveryContacted').mark(subject);
    } catch (err) {
      await logRun(execution, { status: 'failed', stepIndex: i, stepType: step.type, detail: err.message });
    }
    await execution.update({ nextStepIndex: i + 1 });
  }
  return finish(execution, 'completed');
}

async function startRule(rule, trigger, target, subject, { leadingWaitDays = 0 } = {}) {
  const conditions = rule.conditions && !Array.isArray(rule.conditions) ? rule.conditions : {};
  const base = { workspaceId: rule.workspaceId, ruleId: rule.id, trigger, orderId: target.orderId || null };
  const skip = await context.conditionsFail(conditions, subject);
  if (skip) return db.AutomationRun.create({ ...base, status: 'skipped', detail: skip });

  const list = [...(rule.actions || [])];
  if (leadingWaitDays > 0) list.unshift({ type: 'wait', amount: leadingWaitDays, unit: 'days' });
  const execution = await db.AutomationExecution.create({
    ...base,
    checkoutSessionId: target.checkoutSessionId || null,
    steps: list,
    context: {
      signature: subject.signature,
      stopOnStatusChange: conditions.stopOnStatusChange !== false,
      couponCode: conditions.couponCode || null,
      target: target.subscriptionId ? { subscriptionId: target.subscriptionId } : target.customerId ? { customerId: target.customerId } : null,
    },
  });
  return advance(execution);
}

/**
 * An event happened. `target` is { orderId }, { checkoutSessionId },
 * { subscriptionId } or { customerId }.
 * Returns what was started (executions) or skipped (run rows).
 */
async function trigger(workspaceId, eventName, target) {
  const wanted = [{ trigger: eventName, leadingWaitDays: 0 }];
  for (const d of DERIVED_TRIGGERS[eventName] || []) wanted.push({ trigger: d.trigger, defaultDelayDays: d.defaultDelayDays });

  const results = [];
  let subject = null;
  for (const want of wanted) {
    const rules = await db.AutomationRule.findAll({ where: { workspaceId, trigger: want.trigger, isActive: true }, order: [['createdAt', 'ASC']] });
    if (rules.length === 0) continue;
    subject = subject || (await loadSubject(workspaceId, target));
    if (!subject) return results;
    for (const rule of rules) {
      const c = rule.conditions && !Array.isArray(rule.conditions) ? rule.conditions : {};
      const leadingWaitDays = want.defaultDelayDays ? Number(c.delayDays) || want.defaultDelayDays : 0;
      try {
        results.push(await startRule(rule, want.trigger, target, subject, { leadingWaitDays }));
      } catch (err) {
        logger.error(`[automations] rule ${rule.id} failed to start on ${want.trigger}: ${err.message}`);
      }
    }
  }
  return results;
}

/** The queue job that wakes a waiting execution. Safe to run twice. */
async function resume(job) {
  const execution = await db.AutomationExecution.findByPk(job.payload.executionId);
  if (!execution || execution.status !== 'waiting') return null;
  // Claim it: a duplicate delivery of the job finds it already running.
  const [claimed] = await db.AutomationExecution.update({ status: 'running' }, { where: { id: execution.id, status: 'waiting' } });
  if (claimed !== 1) return null;
  execution.status = 'running';
  return advance(execution, { resumed: true });
}

module.exports = { RESUME_JOB, trigger, resume, advance };
