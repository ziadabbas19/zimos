'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticateFlexible } = require('../../core/middleware/authenticateFlexible');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { requireActiveSubscription } = require('../../core/middleware/subscriptionGuard');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./quickstartController');
const schemas = require('./quickstartValidation');

// Merchant store setup, mounted at /api/v1/workspaces/:workspaceId/quickstart.
// Serves plain HTML.
const router = Router({ mergeParams: true });

router.use((req, res, next) => {
  res.removeHeader('Content-Security-Policy'); // inline-styled HTML pages
  next();
});
router.use(authenticateFlexible, resolveTenant);

// GET → the "my store" page once a product exists, or the add-product form
// (also forced with ?add=1).
router.get('/', validate(schemas.workspaceParam), requirePermission(PERMISSIONS.WEBSITE_EDIT), controller.showForm);

// Add another product (regenerates + republishes the store page).
router.post(
  '/',
  validate(schemas.provision),
  requirePermission(PERMISSIONS.WEBSITE_PUBLISH),
  requireActiveSubscription,
  controller.submitForm
);

// Update store branding — EJS form flow (urlencoded, 303 redirect).
router.post(
  '/branding',
  validate(schemas.branding),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  requireActiveSubscription,
  controller.submitBranding
);

// Update branding + themeSettings — JSON flow.
router.patch(
  '/branding',
  validate(schemas.brandingJson),
  requirePermission(PERMISSIONS.WEBSITE_EDIT),
  requireActiveSubscription,
  controller.patchBranding
);

module.exports = router;
