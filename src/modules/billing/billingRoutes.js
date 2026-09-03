'use strict';

const { Router } = require('express');
const { authenticate } = require('../../core/middleware/authenticate');
const { requirePlatformAdmin } = require('../../core/middleware/platformAdminGuard');
const controller = require('./billingController');

// Mounted at /api/v1/billing
const router = Router();

// Gateway webhook — no auth; the (currently stubbed) signature check is the gate.
router.post('/webhook', controller.webhook);

// Manual trial-expiry sweep (a scheduler can call this later).
router.post('/run-trial-check', authenticate, requirePlatformAdmin, controller.runTrialCheck);

module.exports = router;
