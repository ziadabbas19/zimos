'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { requireActiveSubscription } = require('../../core/middleware/subscriptionGuard');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./funnelsController');
const schemas = require('./funnelsValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

const MANAGE = requirePermission(PERMISSIONS.FUNNELS_MANAGE);
const PUBLISH = requirePermission(PERMISSIONS.FUNNELS_PUBLISH);

// --- funnels ---
router.post('/', validate(schemas.createFunnel), MANAGE, requireActiveSubscription, controller.createFunnel);
router.get('/', MANAGE, controller.listFunnels);
router.get('/:funnelId', validate(schemas.funnelIdParam), MANAGE, controller.getFunnel);
router.patch('/:funnelId', validate(schemas.updateFunnel), MANAGE, controller.updateFunnel);
router.delete('/:funnelId', validate(schemas.funnelIdParam), MANAGE, controller.deleteFunnel);

// --- publish / revisions / rollback / pause ---
router.post('/:funnelId/publish', validate(schemas.publish), PUBLISH, requireActiveSubscription, controller.publishFunnel);
router.get('/:funnelId/revisions', validate(schemas.funnelIdParam), MANAGE, controller.listRevisions);
router.post(
  '/:funnelId/revisions/:revisionId/rollback',
  validate(schemas.rollback),
  PUBLISH,
  controller.rollback
);
router.post('/:funnelId/pause', validate(schemas.funnelIdParam), PUBLISH, controller.pause);
router.post('/:funnelId/resume', validate(schemas.funnelIdParam), PUBLISH, controller.resume);

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
