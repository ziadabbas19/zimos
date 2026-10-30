'use strict';

const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');
const entitlements = require('./entitlementsService');
const { featureDefinition, isAvailableFeature } = require('./featureCatalog');

/**
 * requirePlanFeature(key): a route only a store with `key` may use, while
 * PLAN_FEATURE_ENFORCEMENT is on (env.planFeatures.enforcement).
 *
 * Off — the default — every request passes, exactly as before the gate.
 * On, the store's features are its plan's plus the console's overrides
 * (entitlementsService.hasFeature, the one place they are worked out); one
 * that lacks the key gets 403 PLAN_FEATURE_REQUIRED with { feature, label }
 * so the dashboard can name it in its own language and point to the
 * Subscription section. A console grant lets one store through without
 * changing its plan.
 *
 * Mounted after resolveTenant (the store is one the caller belongs to) and
 * after the route's permission check, on a few creation routes only: never on
 * orders, payments or the checkout.
 */
function requirePlanFeature(key) {
  const definition = featureDefinition(key);
  if (!definition) throw new Error(`requirePlanFeature: "${key}" is not in the feature catalogue`);
  return asyncHandler(async (req, res, next) => {
    if (!env.planFeatures.enforcement) return next();
    if (await entitlements.hasFeature(req.tenant.workspaceId, key)) return next();
    throw planFeatureRequired(key);
  });
}

/** The refusal for a store that lacks `key`, for a check made outside a route's middleware. */
function planFeatureRequired(key) {
  const definition = featureDefinition(key);
  return new AppError(
    'PLAN_FEATURE_REQUIRED',
    `Your plan doesn't include ${definition.label.en}. Upgrade your plan to use it.`,
    403,
    { feature: key, label: { ...definition.label } }
  );
}

/**
 * What the dashboard needs to show a screen locked before the gate refuses
 * anything (GET /workspaces/:id/plan-features, any member): the keys the
 * store holds — plan plus overrides, catalogue keys whose feature exists —
 * and whether the gate is on. A screen is locked for a gated route only when
 * `enforced` is true and the key is missing; a feature that is a benefit
 * rather than a refusal (remove_branding) follows the keys alone.
 */
async function planFeaturesFor(workspaceId) {
  const features = (await entitlements.effectiveFeatures(workspaceId)).filter(isAvailableFeature);
  return {
    features,
    enforced: env.planFeatures.enforcement,
    // reviews, about_gallery, combos, advanced_coupons are refused only while
    // GROWTH_REQUIRE_PLAN_FEATURE is on as well (billing/growthFeatures.js).
    growthEnforced: env.planFeatures.enforcement && env.growth.requirePlanFeature,
  };
}

module.exports = { requirePlanFeature, planFeatureRequired, planFeaturesFor };
