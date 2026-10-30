'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const growth = require('../billing/growthFeatures');
const { planFeatureRequired } = require('../billing/planFeatureGate');

/*
 * Migration 730's coupon controls (discountRules.js) and the coupon report are
 * the plan's advanced_coupons (GROWTH_REQUIRE_PLAN_FEATURE,
 * billing/growthFeatures.js). Without it a coupon is created or changed only
 * with each control at its default — the behaviour before them — or as it
 * already stands: a coupon saved with them keeps working as saved and can
 * still be edited while they stay as they are. Plain codes, automatic
 * discounts and the older rules (minimum, products, collections, dates,
 * limits) stay on every plan.
 */

const FEATURE = 'advanced_coupons';

// Each control's column default (models/Discount.js): the old behaviour.
const DEFAULTS = Object.freeze({
  audience: 'any',
  customerPhones: [],
  vipTierIds: [],
  schedule: null,
  maxDiscountAmount: null,
  minQuantity: null,
  excludedProductIds: [],
  appliesToShipping: false,
  appliesToDiscounted: true,
  combinesWithOffers: true,
  strictCustomerLimit: false,
});

// One form for a value sent and the same value read back (BIGINT as a string, jsonb key order, list order).
function same(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return JSON.stringify(value.map(String).sort());
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${k}:${same(Array.isArray(value[k]) ? [...value[k]].sort() : value[k])}`)
      .join(',')}}`;
  }
  return String(value);
}

/** The controls in `body` set to something other than their default and other than `stored`'s. */
function advancedChanges(body, stored) {
  return Object.keys(DEFAULTS).filter(
    (key) => body[key] !== undefined && same(body[key]) !== same(DEFAULTS[key]) && (!stored || same(body[key]) !== same(stored[key]))
  );
}

/** POST /discounts, POST /discounts/bulk, PATCH /discounts/:discountId. */
const controlsGate = asyncHandler(async (req, res, next) => {
  if (!growth.gateOn()) return next();
  const { workspaceId } = req.tenant;
  const stored = req.params.discountId
    ? await db.Discount.findOne({ where: { id: req.params.discountId, workspaceId }, attributes: Object.keys(DEFAULTS) })
    : null;
  if (advancedChanges(req.body || {}, stored && stored.get({ plain: true })).length === 0) return next();
  if (await growth.locked(workspaceId, FEATURE)) throw planFeatureRequired(FEATURE);
  return next();
});

/** GET /discounts/:discountId/report and its CSV. */
const reportGate = growth.requireGrowthFeature(FEATURE);

module.exports = { FEATURE, DEFAULTS, advancedChanges, controlsGate, reportGate };
