'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { requireCreationAllowed, requireLive } = require('../../core/middleware/subscriptionGuard');
const { requireConfirmedAccount } = require('../../core/middleware/confirmedAccount');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./funnelsController');
const schemas = require('./funnelsValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const MANAGE = requirePermission(PERMISSIONS.FUNNELS_MANAGE);
const PUBLISH = requirePermission(PERMISSIONS.FUNNELS_PUBLISH);

// Share code, import by code, the map's draft and the issues list. Registered
// first so `/import` is not read as a funnel id.
require('./funnelExtras').mount(router, { MANAGE, requireCreationAllowed });
// Geo redirects and the funnel's own settings. The funnel's scripts
// (headCode / bodyCode) are live content: changing them takes what a publish does.
require('./geoRedirects').mount(router, { MANAGE, LIVE_CONTENT: [PUBLISH, requireConfirmedAccount, requireLive] });

// --- funnels ---
// Creating a funnel is refused while the store is restricted (unpaid past its
// grace day, or suspended); editing, publishing and pausing are not.
router.post('/', validate(schemas.createFunnel), MANAGE, requireCreationAllowed, controller.createFunnel);
router.get('/', MANAGE, controller.listFunnels);
router.get('/:funnelId', validate(schemas.funnelIdParam), MANAGE, controller.getFunnel);
router.patch('/:funnelId', validate(schemas.updateFunnel), MANAGE, controller.updateFunnel);
// Creates a funnel, so it sits behind the same creation lock as POST /.
router.post(
  '/:funnelId/duplicate',
  validate(schemas.duplicateFunnel),
  MANAGE,
  requireCreationAllowed,
  controller.duplicateFunnel
);
router.delete('/:funnelId', validate(schemas.funnelIdParam), MANAGE, controller.deleteFunnel);

// --- publish / revisions / rollback / pause ---
// Putting a funnel live (publish, rollback, resume) needs a confirmed account
// and a store out of draft; pausing one never does.
router.post('/:funnelId/publish', validate(schemas.publish), PUBLISH, requireConfirmedAccount, requireLive, controller.publishFunnel);
router.get('/:funnelId/revisions', validate(schemas.funnelIdParam), MANAGE, controller.listRevisions);
router.post(
  '/:funnelId/revisions/:revisionId/rollback',
  validate(schemas.rollback),
  PUBLISH,
  requireConfirmedAccount,
  requireLive,
  controller.rollback
);
router.post('/:funnelId/pause', validate(schemas.funnelIdParam), PUBLISH, controller.pause);
router.post('/:funnelId/resume', validate(schemas.funnelIdParam), PUBLISH, requireConfirmedAccount, requireLive, controller.resume);

// --- steps ---
router.post('/:funnelId/steps', validate(schemas.createStep), MANAGE, controller.createStep);
router.get('/:funnelId/steps', validate(schemas.funnelIdParam), MANAGE, controller.listSteps);
router.get('/:funnelId/steps/:stepId', validate(schemas.stepIdParam), MANAGE, controller.getStep);
router.patch('/:funnelId/steps/:stepId', validate(schemas.updateStep), MANAGE, controller.updateStep);
router.delete('/:funnelId/steps/:stepId', validate(schemas.stepIdParam), MANAGE, controller.deleteStep);

// --- edges ---
router.post('/:funnelId/edges', validate(schemas.createEdge), MANAGE, controller.createEdge);
router.get('/:funnelId/edges', validate(schemas.funnelIdParam), MANAGE, controller.listEdges);
router.patch('/:funnelId/edges/:edgeId', validate(schemas.updateEdge), MANAGE, controller.updateEdge);
router.delete('/:funnelId/edges/:edgeId', validate(schemas.edgeIdParam), MANAGE, controller.deleteEdge);

module.exports = router;
