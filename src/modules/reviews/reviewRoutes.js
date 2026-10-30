'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./reviewController');
const schemas = require('./reviewValidation');
const { requireGrowthFeature } = require('../billing/growthFeatures');

// Mounted at /api/v1/workspaces/:workspaceId/reviews — staff moderation.
// The plan's `reviews` with GROWTH_REQUIRE_PLAN_FEATURE (billing/growthFeatures.js).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.PRODUCTS_MANAGE), requireGrowthFeature('reviews'));

router.get('/', validate(schemas.list), controller.list);
// How many wait, are published, are hidden: the sidebar's badge.
router.get('/summary', validate(schemas.summary), controller.summary);
router.patch('/:reviewId', validate(schemas.moderate), controller.moderate);
// Any review: a shopper's or one added by hand.
router.delete('/:reviewId', validate(schemas.remove), controller.remove);
// POST / (add a review by hand).
router.use(require('./manualReviews').router);

module.exports = router;
