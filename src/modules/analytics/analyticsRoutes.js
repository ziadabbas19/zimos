'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { requirePlanFeature } = require('../billing/planFeatureGate');
const controller = require('./analyticsController');
const schemas = require('./analyticsValidation');

// Mounted at /api/v1/workspaces/:workspaceId/analytics
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.ANALYTICS_VIEW));

router.get('/overview', validate(schemas.overview), controller.overview);
router.get('/attribution', validate(schemas.attribution), controller.attribution);
// SPEC §15.4 names the profit report /analytics/pnl; it lives in modules/profit.
router.get('/pnl', (req, res) => res.redirect(307, req.originalUrl.replace('/analytics/pnl', '/profit/pnl')));
router.get('/summary', validate(schemas.summary), controller.summary);
router.get('/funnels', validate(schemas.funnels), controller.funnels);
router.get('/funnels/:funnelId', validate(schemas.funnelDetail), controller.funnelDetail);

// Web analytics (Umami port): pageviews/visitors/visits over analytics_events.
// The advanced_analytics screens: refused without it while
// PLAN_FEATURE_ENFORCEMENT is on (billing/planFeatureGate). The summary and
// the funnel figures above stay open — the dashboard's home page reads them.
const advanced = requirePlanFeature('advanced_analytics');
router.get('/web/stats', validate(schemas.webStats), advanced, controller.webStats);
router.get('/web/series', validate(schemas.webSeries), advanced, controller.webSeries);
router.get('/web/metrics', validate(schemas.webMetrics), advanced, controller.webMetrics);
router.get('/web/weekly', validate(schemas.webWeekly), advanced, controller.webWeekly);
router.get('/web/realtime', validate(schemas.webRealtime), advanced, controller.webRealtime);
// Live view (SPEC §15.2): the snapshot the stream pushes, and the one-minute
// ticket that opens the stream at /api/v1/analytics-stream/:workspaceId (realtimeStream.js).
router.get('/live', validate(schemas.live), controller.live);
router.post('/live/stream-ticket', validate(schemas.liveTicket), controller.liveTicket);
// Sales, products, delivery and customers reports, insights and CSV export.
router.use('/reports', require('./reportsRoutes'));
// Visitors: who came, from where, what they looked at and for how long, the
// funnel, campaigns and outcomes per governorate (traffic/visitorRoutes.js).
// An advanced_analytics screen like the web analytics above.
router.use('/visitors', advanced, require('./traffic/visitorRoutes'));

module.exports = router;
