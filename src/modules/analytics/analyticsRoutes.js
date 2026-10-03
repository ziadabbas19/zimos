'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./analyticsController');
const schemas = require('./analyticsValidation');

// Mounted at /api/v1/workspaces/:workspaceId/analytics
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.ANALYTICS_VIEW));

router.get('/summary', validate(schemas.summary), controller.summary);
// The dashboard home (a window against the one before it) and sales by UTM.
router.get('/overview', validate(schemas.overview), controller.overview);
router.get('/utm', validate(schemas.utm), controller.utm);
router.get('/funnels', validate(schemas.funnels), controller.funnels);
router.get('/funnels/:funnelId', validate(schemas.funnelDetail), controller.funnelDetail);

// Web analytics (Umami port): pageviews/visitors/visits over analytics_events.
router.get('/web/stats', validate(schemas.webStats), controller.webStats);
router.get('/web/series', validate(schemas.webSeries), controller.webSeries);
router.get('/web/metrics', validate(schemas.webMetrics), controller.webMetrics);
router.get('/web/weekly', validate(schemas.webWeekly), controller.webWeekly);
router.get('/web/realtime', validate(schemas.webRealtime), controller.webRealtime);

module.exports = router;
