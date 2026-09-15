'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformAdmin } = require('../../core/middleware/platformAdminGuard');
const controller = require('./platformAdminController');
const schemas = require('./platformAdminValidation');

// Mounted at /api/v1/admin, alongside billing's adminRoutes (which owns
// /workspaces and /dashboard). Platform admin only — no workspace RBAC
// applies, so the guard runs for every route on this router.
const router = Router();
router.use(authenticate, requirePlatformAdmin);

// --- Plans ---------------------------------------------------------------
router.get('/plans', controller.listPlans);
router.post('/plans', validate(schemas.createPlan), controller.createPlan);
router.patch('/plans/:planId', validate(schemas.updatePlan), controller.updatePlan);
router.delete('/plans/:planId', validate(schemas.deletePlan), controller.deletePlan);

// --- Subscriptions -------------------------------------------------------
router.get('/subscriptions', validate(schemas.listSubscriptions), controller.listSubscriptions);

// --- Feature flags -------------------------------------------------------
router.get('/feature-flags', controller.listFlags);
router.post('/feature-flags', validate(schemas.createFlag), controller.createFlag);
router.patch('/feature-flags/:flagId', validate(schemas.updateFlag), controller.updateFlag);
router.delete('/feature-flags/:flagId', validate(schemas.deleteFlag), controller.deleteFlag);

// --- Announcements -------------------------------------------------------
router.get('/announcements', controller.listAnnouncements);
router.post('/announcements', validate(schemas.createAnnouncement), controller.createAnnouncement);
router.patch('/announcements/:announcementId', validate(schemas.updateAnnouncement), controller.updateAnnouncement);
router.delete('/announcements/:announcementId', validate(schemas.deleteAnnouncement), controller.deleteAnnouncement);

module.exports = router;
