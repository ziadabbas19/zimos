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

// --- Overview metrics ----------------------------------------------------
// No query parameters: the windows (30d / 30d / 12mo) are fixed by the
// contract, so there is nothing for a caller to vary and nothing to validate.
router.get('/metrics/overview', controller.getOverview);

// --- Audit log -----------------------------------------------------------
// Read-only by design: audit_logs is append-only (see modules/audit).
router.get('/audit-log', validate(schemas.listAuditLog), controller.listAuditLog);

// --- System services -----------------------------------------------------
// The POST performs no mutation; it is a POST because it deliberately bypasses
// the GET's cache and fires real third-party requests, which is not something
// a browser or proxy should be free to repeat on its own.
router.get('/system/services', controller.listServices);
router.post('/system/services/check', controller.checkServices);

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

// --- Templates -----------------------------------------------------------
// The gallery's write side. /api/v1/templates is public and read-only by
// design (it is the first screen after registration), so everything that
// changes a template lives here, behind the platform-admin guard.
router.get('/templates', validate(schemas.listTemplates), controller.listTemplates);
router.post('/templates', validate(schemas.createTemplate), controller.createTemplate);
router.patch('/templates/:templateId', validate(schemas.updateTemplate), controller.updateTemplate);
router.delete('/templates/:templateId', validate(schemas.deleteTemplate), controller.deleteTemplate);

module.exports = router;
