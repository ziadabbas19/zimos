'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const controller = require('./carrierController');
const schemas = require('./carrierValidation');

// Mounted at /api/v1/webhooks/carriers — public, no session. The token in the
// path is the identity (see carrierWebhookService); rate-limited per token in
// app.js (carrierWebhookLimiter).
const router = Router();

router.post('/:code/:token', validate(schemas.webhook), controller.webhook);

module.exports = router;
