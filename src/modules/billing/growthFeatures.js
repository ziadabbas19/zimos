'use strict';

const env = require('../../config/env');
const entitlements = require('./entitlementsService');
const { requirePlanFeature } = require('./planFeatureGate');

/*
 * GROWTH_REQUIRE_PLAN_FEATURE: six features the console turns on per plan
 * (featureCatalog.js). Like every plan gate they are refused only while
 * PLAN_FEATURE_ENFORCEMENT is on too; off (the default), nothing is read and
 * everything works as before. A key no plan lists is locked for every store,
 * so the keys go into the plans before the switch goes on.
 *
 * A store whose features (plan + console overrides) lack the key:
 *  - reviews: the staff routes refuse (403 PLAN_FEATURE_REQUIRED); the
 *    storefront shows no stars, reviews or form, and a review sent anyway is
 *    answered 404 (reviews/reviewService, reviewController.submissionGate).
 *    Nothing stored is deleted: they show again with the feature.
 *  - about_gallery: a page can't gain a story_gallery block or change one
 *    (one already saved stays as it is), and the live pages leave the block
 *    out (pages/pagesService).
 *  - combos: the staff routes refuse; the storefront offers none, a cart line
 *    naming one shows unavailable and a checkout naming one gets 404
 *    (combos/comboPricing.activeCombo). Orders already placed are untouched.
 *  - cart_rewards: the staff routes refuse; the storefront gets no rewards
 *    config, the shipping quote no `rewards` and the checkout gives none
 *    (cartRewards/cartRewardService.activeSettings). The settings stay stored.
 *    Orders already placed keep the reward they were given.
 *  - email_campaigns: the staff routes refuse, and a scheduled campaign
 *    whose time comes fails (plan_feature) instead of starting. One already
 *    sending goes on; unsubscribe links keep working on every plan.
 *    (emailCampaigns/campaignRoutes.js, campaignSender.startScheduled).
 *  - advanced_coupons: a coupon can't be created or changed with any of
 *    migration 730's controls set (discounts/advancedCoupons.js) and its
 *    report refuses. A coupon already saved with them keeps working as saved,
 *    and can still be edited as long as those controls stay as they are.
 *    Codes, automatic discounts, the minimum, products and collections,
 *    dates and limits stay on every plan.
 */

const KEYS = Object.freeze(['reviews', 'about_gallery', 'combos', 'cart_rewards', 'email_campaigns', 'advanced_coupons']);

const switchOn = () => env.growth.requirePlanFeature === true;
const gateOn = () => switchOn() && env.planFeatures.enforcement === true;

/** True while the store lacks `key` and the gate refuses it. Off: false, nothing read. */
async function locked(workspaceId, key, { transaction } = {}) {
  if (!gateOn()) return false;
  return !(await entitlements.hasFeature(workspaceId, key, { transaction }));
}

/** A staff route only a store with `key` may use, mounted after resolveTenant. */
function requireGrowthFeature(key) {
  if (!KEYS.includes(key)) throw new Error(`requireGrowthFeature: "${key}" is not a growth feature`);
  const planGate = requirePlanFeature(key);
  return (req, res, next) => (switchOn() ? planGate(req, res, next) : next());
}

module.exports = { KEYS, gateOn, locked, requireGrowthFeature };
