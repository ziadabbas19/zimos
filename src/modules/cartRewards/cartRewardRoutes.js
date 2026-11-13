'use strict';

const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { requireGrowthFeature } = require('../billing/growthFeatures');
const service = require('./cartRewardService');
const { schemas } = require('./cartRewardValidation');

/*
 * Cart rewards (CART_REWARDS_ENABLED; off, every route here answers 404).
 *
 * Staff, /api/v1/workspaces/:workspaceId/cart-rewards (discounts.manage, like the coupons):
 *   GET  /   the section as saved (a store that never saved it: off, no tiers)
 *   PUT  /   the whole section: { enabled, allowCouponStacking, tiers, appearance };
 *            `trustItems` is still taken from an older dashboard (the lines now
 *            live with the store's cart behavior, storefront/cartSheet.js)
 * Storefront, /api/v1/store/:workspaceId/cart-rewards — the tiers and trust
 * lines the cart shows; { cartRewards: null } while not in force.
 * With GROWTH_REQUIRE_PLAN_FEATURE, the plan's `cart_rewards` too
 * (billing/growthFeatures.js): without it the staff routes refuse, and the
 * storefront and the checkout get no rewards.
 *
 * What the reward is worth for a cart is in the shipping quote's `rewards`
 * (shipping/shippingQuoteService.js), and the checkout charges it
 * (orders/orderService.createOrder) — both through cartRewardCheckout.price.
 */

const gate = (req, res, next) => (service.flagOn() ? next() : next(new NotFoundError('Cart rewards')));
const ws = (req) => req.tenant.workspaceId;

const staff = Router({ mergeParams: true });
staff.use(gate, authenticate, resolveTenant, requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), requireGrowthFeature('cart_rewards'));
staff.get('/', validate(schemas.get), asyncHandler(async (req, res) => res.json({ cartRewards: await service.getSettings(ws(req)) })));
staff.put('/', validate(schemas.update), asyncHandler(async (req, res) => res.json({ cartRewards: await service.saveSettings(ws(req), req.body, req) })));

// Mounted inside the storefront router (resolvePublicWorkspace already ran).
const store = Router({ mergeParams: true });
store.get(
  '/cart-rewards',
  gate,
  validate(schemas.publicConfig),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ cartRewards: await service.publicConfig(ws(req)) });
  })
);

module.exports = { staff, store };
