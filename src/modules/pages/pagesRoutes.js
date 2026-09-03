'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { requireActiveSubscription } = require('../../core/middleware/subscriptionGuard');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./pagesController');
const schemas = require('./pagesValidation');

const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant);

// --- websites ---
router.post(
  '/',
  validate(schemas.createWebsite),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  requireActiveSubscription,
  controller.createWebsite
);
router.get('/', requirePermission(PERMISSIONS.WEBSITE_EDIT), controller.listWebsites);
router.get('/:websiteId', validate(schemas.websiteIdParam), requirePermission(PERMISSIONS.WEBSITE_EDIT), controller.getWebsite);
router.patch('/:websiteId', validate(schemas.updateWebsite), requirePermission(PERMISSIONS.WEBSITE_EDIT), controller.updateWebsite);
router.delete('/:websiteId', validate(schemas.websiteIdParam), requirePermission(PERMISSIONS.WEBSITE_EDIT), controller.deleteWebsite);

// --- publish / revisions / rollback ---
router.post(
  '/:websiteId/publish',
  validate(schemas.publish),
  requirePermission(PERMISSIONS.WEBSITE_PUBLISH),
  requireActiveSubscription,
  controller.publishWebsite
);
router.get(
  '/:websiteId/revisions',
  validate(schemas.websiteIdParam),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.listRevisions
);
router.post(
  '/:websiteId/revisions/:revisionId/rollback',
  validate(schemas.rollback),
  requirePermission(PERMISSIONS.WEBSITE_PUBLISH),
  controller.rollback
);

// --- pages ---
router.post(
  '/:websiteId/pages',
  validate(schemas.createPage),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.createPage
);
router.get(
  '/:websiteId/pages',
  validate(schemas.websiteIdParam),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.listPages
);
router.get(
  '/:websiteId/pages/:pageId',
  validate(schemas.pageIdParam),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.getPage
);
router.patch(
  '/:websiteId/pages/:pageId',
  validate(schemas.updatePage),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.updatePage
);
router.delete(
  '/:websiteId/pages/:pageId',
  validate(schemas.pageIdParam),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  controller.deletePage
);

module.exports = router;
