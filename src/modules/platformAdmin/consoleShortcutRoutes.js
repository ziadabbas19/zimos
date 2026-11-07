'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { requireConsoleAccount } = require('../../core/middleware/platformAdminGuard');
const consoleShortcuts = require('./consoleShortcuts');

// The account's own rows (consoleShortcuts.js), mounted under /api/v1/admin:
// the shortcuts on its first page and the phone's bottom bar. Open to any
// console account; no route names an account, so nobody reads or changes
// anyone else's, and what each may put on a row is the service's filter.
const router = Router();

const rows = [
  ['/me/home-shortcuts', 'home', 'homeShortcuts'],
  ['/me/mobile-nav', 'mobileNav', 'mobileNav'],
];

for (const [path, row, key] of rows) {
  const { max } = consoleShortcuts.ROWS[row];
  router.get(
    path,
    requireConsoleAccount,
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      res.json({ [key]: await consoleShortcuts.read(row, req.user) });
    })
  );
  router.put(
    path,
    requireConsoleAccount,
    validate({
      body: Joi.object({
        shortcuts: Joi.array()
          .items(Joi.string().valid(...consoleShortcuts.CONSOLE_SHORTCUT_IDS))
          .max(max)
          .unique()
          .required(),
      }),
    }),
    asyncHandler(async (req, res) => res.json({ [key]: await consoleShortcuts.save(row, req.user, req.body.shortcuts) }))
  );
  router.delete(
    path,
    requireConsoleAccount,
    asyncHandler(async (req, res) => res.json({ [key]: await consoleShortcuts.reset(row, req.user) }))
  );
}

module.exports = router;
