'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requireConsoleAccount } = require('../../core/middleware/platformAdminGuard');
const notifications = require('./platformNotificationService');

// The console's notifications (platformNotificationService), mounted under
// /api/v1/admin like the rest of the console. Each admin reads, marks read
// and sets preferences for themselves only; reads are not audited. Open to any
// console account: what each is told about is the service's filter, the types
// their console permissions open (platformNotificationService.TYPE_PERMISSION).
const router = Router();
const type = Joi.string().valid(...notifications.TYPES);

const schemas = {
  list: {
    query: Joi.object({
      type: type.optional(),
      unread: Joi.boolean().truthy('1').falsy('0').default(false),
      cursor: Joi.string().max(200).optional(),
      limit: Joi.number().integer().min(1).max(50).default(20),
    }),
  },
  read: {
    body: Joi.object({
      ids: Joi.array().items(Joi.string().uuid()).max(200),
      all: Joi.boolean(),
    }).xor('ids', 'all'),
  },
  prefs: {
    body: Joi.object({
      prefs: Joi.array()
        .items(Joi.object({ type: type.required(), enabled: Joi.boolean().required(), email: Joi.boolean().default(false) }))
        .min(1)
        .max(notifications.TYPES.length)
        .required(),
    }),
  },
};

router.get(
  '/notifications',
  requireConsoleAccount,
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json(await notifications.list(req.user, req.query)))
);
router.get(
  '/notifications/unread-count',
  requireConsoleAccount,
  asyncHandler(async (req, res) => res.json({ unread: await notifications.unreadCount(req.user) }))
);
router.post(
  '/notifications/read',
  requireConsoleAccount,
  validate(schemas.read),
  asyncHandler(async (req, res) => res.json(await notifications.markRead(req.user, req.body)))
);
router.get('/notification-prefs', requireConsoleAccount, asyncHandler(async (req, res) => res.json(await notifications.getPrefs(req.user))));
router.put(
  '/notification-prefs',
  requireConsoleAccount,
  validate(schemas.prefs),
  asyncHandler(async (req, res) => res.json(await notifications.savePrefs(req.user, req.body.prefs)))
);

module.exports = router;
