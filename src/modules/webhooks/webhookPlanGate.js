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
 * edited, paused, tested and deleted, on any plan. Off (the default): every
 * request passes, as before.
 */
const apiAccess = requirePlanFeature('api_access');

function newEndpointGate(req, res, next) {
  if (!env.webhooks.requireApiAccess) return next();
  return apiAccess(req, res, next);
}

module.exports = { newEndpointGate };
