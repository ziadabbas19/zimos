'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op, fn, col } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { TRIGGERS, TOKENS } = require('./automationEngine');
const { STEP_TYPES, WAIT_UNITS } = require('./automationSteps');
const templates = require('./automationTemplates');
const whatsappPlanGate = require('../whatsapp/whatsappPlanGate');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };

const text = (max) => Joi.string().trim().min(1).max(max);
// One step of the sequence; the shape depends on its type (automationSteps.js).
const step = Joi.alternatives().conditional('.type', {
  switch: [
    { is: 'wait', then: Joi.object({ type: Joi.valid('wait').required(), amount: Joi.number().integer().min(1).max(720).required(), unit: Joi.string().valid(...Object.keys(WAIT_UNITS)).required() }) },
    {
      is: 'whatsapp_template',
      then: Joi.object({
        type: Joi.valid('whatsapp_template').required(),
        template: Joi.string().pattern(/^[a-z0-9_]{1,512}$/).required(),
        language: Joi.string().pattern(/^[a-z]{2,3}(_[A-Z]{2})?$/).default('ar'),
        params: Joi.array().items(Joi.string().max(1000)).max(20).default([]),
      }),
    },
    { is: 'sms', then: Joi.object({ type: Joi.valid('sms').required(), body: text(600).required() }) },
    { is: 'email', then: Joi.object({ type: Joi.valid('email').required(), subject: text(200).required(), body: text(5000).required() }) },
    { is: 'webhook', then: Joi.object({ type: Joi.valid('webhook').required(), url: Joi.string().uri({ scheme: ['https', 'http'] }).max(2000).required() }) },
    { is: 'add_tag', then: Joi.object({ type: Joi.valid('add_tag').required(), tag: text(40).required() }) },
    { is: 'set_status', then: Joi.object({ type: Joi.valid('set_status').required(), status: Joi.string().valid('confirmed', 'cancelled').required() }) },
    { is: 'notify_team', then: Joi.object({ type: Joi.valid('notify_team').required(), message: text(500).required() }) },
  ],
  otherwise: Joi.object({ type: Joi.string().valid(...STEP_TYPES).required() }),
});

const ruleBody = {
  name: Joi.string().min(2).max(200),
  trigger: Joi.string().valid(...TRIGGERS),
  isActive: Joi.boolean(),
  conditions: Joi.object({
    paymentMethod: Joi.string().valid(...require('../payments/methodNames').ORDER_METHODS).allow(null),
    minTotalAmount: Joi.number().integer().min(0).allow(null),
    productIds: Joi.array().items(uuid).max(50),
    governorates: Joi.array().items(Joi.string().trim().max(100)).max(40),
    source: Joi.string().valid('store', 'funnel').allow(null),
    funnelIds: Joi.array().items(uuid).max(50),
    // The levels orders are stored with (risk/riskService). "medium", the name the dashboard sent
    // before, is saved as "moderate", the level it always meant.
    riskLevel: Joi.array()
      .items(Joi.string().valid('low', 'moderate', 'high', 'medium').custom((level) => (level === 'medium' ? 'moderate' : level)))
      .max(3),
    isFirstOrder: Joi.boolean().allow(null),
    tags: Joi.array().items(Joi.string().trim().max(40)).max(20),
    // Only contacts in this segment / never contacts in that one (segmentCondition.js).
    segmentId: uuid.allow(null),
    excludeSegmentId: uuid.allow(null),
    // Stop a waiting sequence when the order's status changed meanwhile (default true).
    stopOnStatusChange: Joi.boolean(),
    // review.request: days after delivery (default 3).
    delayDays: Joi.number().integer().min(1).max(60),
    // The value of {{coupon_code}} in this rule's messages.
    couponCode: Joi.string().trim().max(100).allow(null, ''),
  }).default({}),
  // An ordered sequence; it may not end on a wait, and needs at least one step that does something.
  actions: Joi.array()
    .items(step)
    .min(1)
    .max(12)
    .custom((value, helpers) => {
      if (value.every((s) => s.type === 'wait')) return helpers.message('The sequence needs at least one step besides waiting');
      if (value[value.length - 1].type === 'wait') return helpers.message('The sequence cannot end with a wait');
      return value;
    }),
};

const view = (r, stats = {}) => ({
  id: r.id,
  name: r.name,
  trigger: r.trigger,
  isActive: r.isActive,
  templateKey: r.templateKey || null,
  conditions: r.conditions && !Array.isArray(r.conditions) ? r.conditions : {},
  actions: r.actions || [],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  stats: { sent: stats.sent || 0, skipped: stats.skipped || 0, failed: stats.failed || 0, lastRunAt: stats.lastRunAt || null },
});

const list = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  const rules = await db.AutomationRule.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  const runs = rules.length
    ? await db.AutomationRun.findAll({
        where: { workspaceId, ruleId: rules.map((r) => r.id) },
        attributes: ['ruleId', 'status', [fn('COUNT', col('id')), 'count'], [fn('MAX', col('created_at')), 'lastRunAt']],
        group: ['ruleId', 'status'],
        raw: true,
      })
    : [];
  const stats = {};
  for (const r of runs) {
    const s = (stats[r.ruleId] = stats[r.ruleId] || {});
    s[r.status] = Number(r.count);
    if (!s.lastRunAt || new Date(r.lastRunAt) > new Date(s.lastRunAt)) s.lastRunAt = r.lastRunAt;
  }
  res.json({ rules: rules.map((r) => view(r, stats[r.id])), triggers: TRIGGERS, tokens: TOKENS, stepTypes: STEP_TYPES });
});

// WEBHOOKS_REQUIRE_API_ACCESS: a rule's first webhook step needs api_access, as a new endpoint does.
const { assertNewWebhookStep } = require('../webhooks/webhookPlanGate');

const create = asyncHandler(async (req, res) => {
  await assertNewWebhookStep(req, [], req.body.actions);
  // Whoever saves the steps decides whether its webhook steps send customers in full (automationSteps.js).
  const rule = await db.AutomationRule.create({ ...req.body, workspaceId: req.tenant.workspaceId, configuredByUserId: req.user.id });
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'automation.create', entityType: 'AutomationRule', entityId: rule.id, after: view(rule), req });
  res.status(201).json({ rule: view(rule) });
});

const update = asyncHandler(async (req, res) => {
  const rule = await db.AutomationRule.findOne({ where: { id: req.params.ruleId, workspaceId: req.tenant.workspaceId } });
  if (!rule) throw new NotFoundError('AutomationRule');
  const before = view(rule);
  if (req.body.actions !== undefined) await assertNewWebhookStep(req, rule.actions, req.body.actions);
  await rule.update({ ...req.body, ...(req.body.actions !== undefined ? { configuredByUserId: req.user.id } : {}) });
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'automation.update', entityType: 'AutomationRule', entityId: rule.id, before, after: view(rule), req });
  res.json({ rule: view(rule) });
});

const remove = asyncHandler(async (req, res) => {
  const rule = await db.AutomationRule.findOne({ where: { id: req.params.ruleId, workspaceId: req.tenant.workspaceId } });
  if (!rule) throw new NotFoundError('AutomationRule');
  await rule.destroy();
  await recordAudit({ workspaceId: req.tenant.workspaceId, actorUserId: req.user.id, action: 'automation.delete', entityType: 'AutomationRule', entityId: rule.id, before: view(rule), req });
  res.json({ deleted: true, id: rule.id });
});

const runs = asyncHandler(async (req, res) => {
  const { ruleId, limit, before, status } = req.query;
  const where = { workspaceId: req.tenant.workspaceId };
  if (ruleId) where.ruleId = ruleId;
  if (status) where.status = status;
  if (before) where.createdAt = { [Op.lt]: new Date(before) };
  const rows = await db.AutomationRun.findAll({ where, order: [['createdAt', 'DESC']], limit });
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter(Boolean))];
  const orders = orderIds.length ? await db.Order.findAll({ where: { id: orderIds }, attributes: ['id', 'orderNumber'] }) : [];
  const byId = new Map(orders.map((o) => [o.id, o.orderNumber]));
  res.json({
    runs: rows.map((r) => ({ id: r.id, ruleId: r.ruleId, trigger: r.trigger, status: r.status, detail: r.detail, stepIndex: r.stepIndex, stepType: r.stepType, executionId: r.executionId, createdAt: r.createdAt, order: r.orderId ? { id: r.orderId, orderNumber: byId.get(r.orderId) || null } : null })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt.toISOString() : null,
  });
});

/** The ready-made automations, each with whether this store already switched it on. */
const listTemplates = asyncHandler(async (req, res) => {
  const rules = await db.AutomationRule.findAll({ where: { workspaceId: req.tenant.workspaceId, templateKey: { [Op.ne]: null } }, attributes: ['id', 'templateKey'] });
  const enabled = new Map(rules.map((r) => [r.templateKey, r.id]));
  // planLocked: switching it on would be refused for the plan (whatsapp/whatsappPlanGate.js); a rule the store has stays unlocked.
  const confirmationLocked = await whatsappPlanGate.lockedForPlan(req.tenant.workspaceId);
  res.json({
    templates: templates.TEMPLATES.map((t) => ({
      ...templates.publicView(t),
      ruleId: enabled.get(t.key) || null,
      planLocked: confirmationLocked && t.key === whatsappPlanGate.CONFIRMATION_TEMPLATE_KEY && !enabled.has(t.key),
    })),
  });
});

/** One click: the template becomes a rule of this store (a second click returns the same rule). */
const enableTemplate = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  const template = templates.byKey(req.params.key);
  if (!template) throw new NotFoundError('AutomationTemplate');
  const existing = await db.AutomationRule.findOne({ where: { workspaceId, templateKey: template.key } });
  if (existing) return res.json({ rule: view(existing), created: false });
  const made = templates.ruleFrom(template, req.body.couponCode);
  const rule = await db.AutomationRule.create({
    workspaceId,
    name: template.name[req.body.locale === 'en' ? 'en' : 'ar'],
    trigger: template.trigger,
    conditions: made.conditions,
    actions: made.steps,
    isActive: true,
    templateKey: template.key,
    configuredByUserId: req.user.id,
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'automation.create', entityType: 'AutomationRule', entityId: rule.id, after: view(rule), metadata: { templateKey: template.key }, req });
  return res.status(201).json({ rule: view(rule), created: true });
});

// Mounted at /api/v1/workspaces/:workspaceId/automations
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.AUTOMATIONS_MANAGE));
router.get('/', validate({ params: Joi.object(ws) }), list);
router.get('/templates', validate({ params: Joi.object(ws) }), listTemplates);
router.post(
  '/templates/:key/enable',
  validate({ params: Joi.object({ ...ws, key: Joi.string().max(60).required() }), body: Joi.object({
      locale: Joi.string().valid('ar', 'en').default('ar'),
      // A template that offers a coupon (acceptsCoupon): the code its last message gives.
      couponCode: Joi.string().trim().max(100).allow(null, '').optional(),
    }).default({}) }),
  // WHATSAPP_REQUIRE_PLAN_FEATURE: a new WhatsApp confirmation rule needs whatsapp_confirmation (whatsapp/whatsappPlanGate.js).
  whatsappPlanGate.confirmationTemplateGate,
  enableTemplate
);
router.get(
  '/runs',
  validate({
    params: Joi.object(ws),
    query: Joi.object({ ruleId: uuid, status: Joi.string().valid('sent', 'skipped', 'failed'), limit: Joi.number().integer().min(1).max(100).default(50), before: Joi.date().iso() }),
  }),
  runs
);
router.post(
  '/',
  validate({ params: Joi.object(ws), body: Joi.object({ ...ruleBody, name: ruleBody.name.required(), trigger: ruleBody.trigger.required(), actions: ruleBody.actions.required() }) }),
  create
);
router.patch('/:ruleId', validate({ params: Joi.object({ ...ws, ruleId: uuid.required() }), body: Joi.object(ruleBody).min(1) }), update);
router.delete('/:ruleId', validate({ params: Joi.object({ ...ws, ruleId: uuid.required() }) }), remove);

module.exports = router;
