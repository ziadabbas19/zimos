'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const service = require('./whatsappService');
const planGate = require('./whatsappPlanGate');

const uuid = Joi.string().uuid();
const ws = { workspaceId: uuid.required() };

/** Public base URL of this API, for the webhook URL shown to the merchant. */
function apiBase(req) {
  const explicit = process.env.PUBLIC_API_URL;
  if (explicit) return `${explicit.replace(/\/+$/, '')}/api/${env.apiVersion}`;
  return `${req.protocol}://${req.get('host')}/api/${env.apiVersion}`;
}

// ---------------------------------------------------------------------------
// Staff — mounted at /api/v1/workspaces/:workspaceId/whatsapp
// ---------------------------------------------------------------------------
const staff = Router({ mergeParams: true });
staff.use(authenticate, resolveTenant);
// The account's message templates, synced from Meta (whatsappTemplates.js).
staff.use(require('./whatsappTemplates').router);

staff.get(
  '/integration',
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => {
    const view = service.integrationView(await service.getIntegration(req.tenant.workspaceId), apiBase(req));
    // planLocked: a new connection would be refused for the plan (whatsappPlanGate.js), so the dashboard says so first.
    res.json({ integration: { ...view, planLocked: await planGate.lockedForPlan(req.tenant.workspaceId) } });
  })
);

staff.put(
  '/integration',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      phoneNumberId: Joi.string().pattern(/^\d{5,30}$/).required(),
      accessToken: Joi.string().min(20).max(1000).required(),
      businessAccountId: Joi.string().pattern(/^\d{5,30}$/).allow('', null).optional(),
      // Required unless one is already saved (whatsappService.connect: 422 WHATSAPP_APP_SECRET_REQUIRED).
      appSecret: Joi.string().min(16).max(200).allow('', null).optional(),
    }),
  }),
  // WHATSAPP_REQUIRE_PLAN_FEATURE: a first connection needs whatsapp_confirmation (whatsappPlanGate.js).
  planGate.newConnectionGate,
  asyncHandler(async (req, res) => {
    const integration = await service.connect(req.tenant.workspaceId, req.body, req);
    res.json({ integration: service.integrationView(integration, apiBase(req)) });
  })
);

staff.delete(
  '/integration',
  requirePermission(PERMISSIONS.WORKSPACE_MANAGE),
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => res.json(await service.disconnect(req.tenant.workspaceId, req)))
);

staff.get(
  '/conversations',
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  validate({
    params: Joi.object(ws),
    query: Joi.object({ status: Joi.string().valid('open', 'closed'), search: Joi.string().max(100).allow(''), limit: Joi.number().integer().min(1).max(100).default(50), before: Joi.date().iso() }),
  }),
  asyncHandler(async (req, res) => res.json(await service.listConversations(req.tenant.workspaceId, req.query)))
);

staff.get(
  '/conversations/:conversationId/messages',
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  validate({ params: Joi.object({ ...ws, conversationId: uuid.required() }), query: Joi.object({ limit: Joi.number().integer().min(1).max(200).default(100), before: Joi.date().iso() }) }),
  asyncHandler(async (req, res) => res.json(await service.listMessages(req.tenant.workspaceId, req.params.conversationId, req.query)))
);

staff.patch(
  '/conversations/:conversationId',
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  validate({ params: Joi.object({ ...ws, conversationId: uuid.required() }), body: Joi.object({ status: Joi.string().valid('open', 'closed').required() }) }),
  asyncHandler(async (req, res) => res.json({ conversation: await service.setConversationStatus(req.tenant.workspaceId, req.params.conversationId, req.body.status) }))
);

staff.post(
  '/messages',
  requirePermission(PERMISSIONS.ORDERS_CONFIRM),
  validate({
    params: Joi.object(ws),
    body: Joi.object({
      to: Joi.string().min(6).max(32).required(),
      text: Joi.string().min(1).max(4096),
      template: Joi.object({
        name: Joi.string().pattern(/^[a-z0-9_]{1,512}$/).required(),
        language: Joi.string().pattern(/^[a-z]{2,3}(_[A-Z]{2})?$/).default('ar'),
        params: Joi.array().items(Joi.string().max(1000)).max(20).default([]),
      }),
    }).xor('text', 'template'),
  }),
  asyncHandler(async (req, res) => {
    const m = await service.sendMessage(req.tenant.workspaceId, req.body, req);
    res.status(201).json({ message: { id: m.id, conversationId: m.conversationId, direction: m.direction, type: m.type, body: m.body, status: m.status, createdAt: m.createdAt } });
  })
);

// ---------------------------------------------------------------------------
// Public webhook — mounted at /api/v1/webhooks/whatsapp
// ---------------------------------------------------------------------------
const webhook = Router();

webhook.get(
  '/:workspaceId',
  validate({ params: Joi.object(ws), query: Joi.object().unknown(true) }),
  asyncHandler(async (req, res) => {
    const challenge = await service.verifyWebhookSubscription(req.params.workspaceId, {
      mode: req.query['hub.mode'],
      token: req.query['hub.verify_token'],
      challenge: req.query['hub.challenge'],
    });
    if (challenge === null || challenge === undefined) return res.status(403).send('Forbidden');
    return res.status(200).type('text/plain').send(String(challenge));
  })
);

webhook.post(
  '/:workspaceId',
  validate({ params: Joi.object(ws) }),
  asyncHandler(async (req, res) => {
    const ok = await service.verifyWebhookSignature(req.params.workspaceId, req.rawBody, req.headers['x-hub-signature-256']);
    if (!ok) return res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } });
    const result = await service.handleWebhook(req.params.workspaceId, req.body);
    return res.json({ received: true, ...result });
  })
);

module.exports = { staff, webhook };
