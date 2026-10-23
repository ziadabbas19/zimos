'use strict';

const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const validate = require('../../../core/middleware/validate');
const { requirePlanFeature } = require('../../billing/planFeatureGate');
const insights = require('./visitorInsightsService');
const { merchant: schemas } = require('./visitorValidation');

// The merchant's "Visitors" section, mounted at
// /api/v1/workspaces/:workspaceId/analytics/visitors behind the analytics
// router's authenticate → resolveTenant → requirePermission(analytics.view)
// and its advanced_analytics plan gate. Every query is scoped to
// req.tenant.workspaceId, never to anything the request names; no IP (hashed
// or not) is in any answer.
//
// The summary needs advanced_analytics only. The visits, one visit in order,
// the outcomes per governorate and the campaigns also need visitor_insights
// (while PLAN_FEATURE_ENFORCEMENT is on; the same 403 PLAN_FEATURE_REQUIRED).
const router = Router({ mergeParams: true });
const scope = (req) => ({ workspaceId: req.tenant.workspaceId });
const insightsPlan = requirePlanFeature('visitor_insights');

router.get('/summary', validate(schemas.summary), asyncHandler(async (req, res) => res.json(await insights.summary(scope(req), req.query))));
router.get('/sessions', validate(schemas.sessions), insightsPlan, asyncHandler(async (req, res) => res.json(await insights.sessions(scope(req), req.query))));
router.get(
  '/sessions/:sessionId',
  validate(schemas.session),
  insightsPlan,
  asyncHandler(async (req, res) => res.json(await insights.sessionTimeline(req.tenant.workspaceId, req.params.sessionId)))
);
router.get('/campaigns', validate(schemas.campaigns), insightsPlan, asyncHandler(async (req, res) => res.json(await insights.campaigns(scope(req), req.query))));
router.get(
  '/governorates',
  validate(schemas.governorates),
  insightsPlan,
  asyncHandler(async (req, res) => res.json(await insights.governorateOutcomes(scope(req), req.query)))
);

module.exports = router;
