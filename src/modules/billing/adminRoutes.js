'use strict';

const { Router } = require('express');
const { authenticate } = require('../../core/middleware/authenticate');
const { authenticateFlexible } = require('../../core/middleware/authenticateFlexible');
const { requirePlatformAdmin } = require('../../core/middleware/platformAdminGuard');
const controller = require('./billingController');

// Mounted at /api/v1/admin
const router = Router();

router.get('/workspaces', authenticate, requirePlatformAdmin, controller.adminWorkspaces);
// HTML dashboard — authenticateFlexible so it opens in a browser (?token=).
router.get('/dashboard', authenticateFlexible, requirePlatformAdmin, controller.adminDashboard);

module.exports = router;
