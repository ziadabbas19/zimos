'use strict';

const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const validate = require('../../../core/middleware/validate');
const { authenticate } = require('../../../core/middleware/authenticate');
const { pushTestLimiter } = require('../../../core/middleware/accountLimiter');
const pushConfig = require('./pushConfig');
const pushService = require('./pushService');
const schemas = require('./pushValidation');
// The hooks that remove a device when its session ends (no-op while push is off).
require('./pushSessions');

/**
 * Mounted at /api/v1/me/push: the signed-in account's own devices, in no store.
 * While push is off (pushConfig.isOn()) every path here goes on to the app's
 * 404, as before this existed — the dashboard reads that as "off".
 *
 *   GET    /config                the VAPID public key to subscribe with
 *   PUT    /subscriptions         this browser subscribed (again)
 *   GET    /subscriptions         my devices (?app=dashboard|console)
 *   PATCH  /subscriptions/:id     { enabled }
 *   DELETE /subscriptions/:id
 *   POST   /test                  a test notification ({ id } or this browser)
 */
const router = Router();

// PUSH_ENABLED on without a usable VAPID pair is reported once, at start.
pushConfig.isOn();

router.use((req, res, next) => (pushConfig.isOn() ? next() : next('router')));
router.use(authenticate);

router.get('/config', (req, res) => res.json(pushService.config()));
router.put(
  '/subscriptions',
  validate(schemas.subscribe),
  asyncHandler(async (req, res) => res.json(await pushService.subscribe(req.user, req.body, req)))
);
router.get(
  '/subscriptions',
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json(await pushService.list(req.user, req.query, req)))
);
router.patch(
  '/subscriptions/:id',
  validate(schemas.setEnabled),
  asyncHandler(async (req, res) => res.json(await pushService.setEnabled(req.user, req.params.id, req.body, req)))
);
router.delete(
  '/subscriptions/:id',
  validate(schemas.remove),
  asyncHandler(async (req, res) => res.json(await pushService.remove(req.user, req.params.id)))
);
router.post(
  '/test',
  pushTestLimiter,
  validate(schemas.test),
  asyncHandler(async (req, res) => res.json(await pushService.sendTest(req.user, req.body, req)))
);

module.exports = router;
