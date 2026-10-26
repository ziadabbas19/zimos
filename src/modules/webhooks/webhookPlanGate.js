'use strict';

const env = require('../../config/env');
const { requirePlanFeature } = require('../billing/planFeatureGate');

/**
 * WEBHOOKS_REQUIRE_API_ACCESS: adding a webhook endpoint needs the plan's
 * api_access, as minting an API key does — from the dashboard and from the
 * public API alike. Like every plan gate it refuses (403
 * PLAN_FEATURE_REQUIRED) only while PLAN_FEATURE_ENFORCEMENT is on too.
 *
 * Only adding: endpoints a store already has keep sending, and can still be
 * edited, paused, tested and deleted, on any plan. An automation's first
 * webhook step is an addition too (assertNewWebhookStep). Off (the default):
 * every request passes, as before.
 */
const apiAccess = requirePlanFeature('api_access');

function newEndpointGate(req, res, next) {
  if (!env.webhooks.requireApiAccess) return next();
  return apiAccess(req, res, next);
}

const hasWebhookStep = (actions) => (Array.isArray(actions) ? actions : []).some((step) => step && step.type === 'webhook');

/**
 * The same for an automation: a rule that gets its first webhook step (a new
 * rule with one, or one added to a rule that had none) needs api_access too.
 * A rule that already sends to a URL keeps running and can still be edited,
 * its address changed included — as an endpoint can. Rejects with 403
 * PLAN_FEATURE_REQUIRED; resolves otherwise.
 */
async function assertNewWebhookStep(req, before, after) {
  if (!env.webhooks.requireApiAccess || !hasWebhookStep(after) || hasWebhookStep(before)) return;
  await new Promise((resolve, reject) => apiAccess(req, {}, (err) => (err ? reject(err) : resolve())));
}

module.exports = { newEndpointGate, assertNewWebhookStep };
