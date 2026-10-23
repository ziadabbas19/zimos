'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const controller = require('./onlinePaymentController');
const schemas = require('./onlinePaymentValidation');

// Mounted at /api/v1/webhooks/payments — public, no session. The token in the
// path names the account and the signature proves the sender (see
// paymentEventService.acceptWebhook); rate-limited per token in app.js.
const router = Router();

router.post('/:code/:token', validate(schemas.webhook), controller.webhook);
// A last segment some gateways need in the URL (Fawaterak sends its paid
// webhook as JSON only to a path with `_json` in it).
router.post('/:code/:token/:variant', validate(schemas.webhook), controller.webhook);

module.exports = router;
