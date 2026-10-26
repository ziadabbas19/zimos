'use strict';

const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const db = require('../../db/models');
const entitlements = require('../billing/entitlementsService');
const { requirePlanFeature } = require('../billing/planFeatureGate');

/**
 * WHATSAPP_REQUIRE_PLAN_FEATURE: the plan's whatsapp_confirmation is needed to
 * connect a WhatsApp number and to switch on the ready-made "Confirm the
 * order on WhatsApp" automation. Like every plan gate it refuses (403
 * PLAN_FEATURE_REQUIRED) only while PLAN_FEATURE_ENFORCEMENT is on too.
 *
 * Only what is new: a store already connected keeps its number on any plan
 * (it can reconnect with a new token, add its App Secret, disconnect), and a
 * confirmation rule it already has keeps running and can be paused and
 * resumed. Off (the default): every request passes, as before. Never on
 * orders (planFeatureGate.js): "Confirm via WhatsApp" on the order page stays
 * open, and without a connection it only offers a wa.me link.
 */

const FEATURE = 'whatsapp_confirmation';
// The ready-made automation that sends the confirmation message (automations/automationTemplates.js).
const CONFIRMATION_TEMPLATE_KEY = 'order_confirmation';
const planGate = requirePlanFeature(FEATURE);

const gateOn = () => env.whatsapp.requirePlanFeature;

/** For the dashboard: true while a new connection (or a new confirmation rule) would be refused. */
async function lockedForPlan(workspaceId) {
  if (!gateOn() || !env.planFeatures.enforcement) return false;
  return !(await entitlements.hasFeature(workspaceId, FEATURE));
}

/** PUT /whatsapp/integration: a first connection needs the feature; an existing one is edited on any plan. */
const newConnectionGate = asyncHandler(async (req, res, next) => {
  if (!gateOn()) return next();
  const existing = await db.WorkspaceIntegration.findOne({ where: { workspaceId: req.tenant.workspaceId, provider: 'whatsapp_cloud' }, attributes: ['id'] });
  if (existing) return next();
  return planGate(req, res, next);
});

/** POST /automations/templates/:key/enable: a new confirmation rule needs the feature; the others pass. */
const confirmationTemplateGate = asyncHandler(async (req, res, next) => {
  if (!gateOn() || req.params.key !== CONFIRMATION_TEMPLATE_KEY) return next();
  const existing = await db.AutomationRule.findOne({ where: { workspaceId: req.tenant.workspaceId, templateKey: CONFIRMATION_TEMPLATE_KEY }, attributes: ['id'] });
  // Already switched on: the route answers that rule again, as before.
  if (existing) return next();
  return planGate(req, res, next);
});

module.exports = { FEATURE, CONFIRMATION_TEMPLATE_KEY, lockedForPlan, newConnectionGate, confirmationTemplateGate };
