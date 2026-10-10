'use strict';

// Counters are shared through Redis when RATE_LIMIT_REDIS and REDIS_URL are set (rateLimitStore.js).
const rateLimit = require('./rateLimitStore').withSharedStore(require('express-rate-limit'));
const env = require('../../config/env');
const { RateLimitError } = require('../errors/AppError');

/*
 * Changes to a signed-in account (auth/accountService: name, username,
 * email, phone), limited per ACCOUNT, not per IP: in production many people
 * can share one IP, and these routes always know who is asking. Mounted after
 * `authenticate`. Skipped under tests, like the other limiters.
 */
const ACCOUNT_CHANGES_PER_HOUR = 20;

const accountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: ACCOUNT_CHANGES_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest,
  keyGenerator: (req) => `account:${req.user.id}`,
  handler: (req, res, next) => next(new RateLimitError()),
});

/*
 * The look of the dashboard saved to the account (auth/uiPreferencesService):
 * per account in the same way, on a counter of its own. The dashboard saves
 * as its owner moves a slider (once it rests), which must not use up the
 * changes above; refused here, the look is only saved a little later.
 */
const UI_PREFERENCE_SAVES_PER_HOUR = 120;

const uiPreferencesLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: UI_PREFERENCE_SAVES_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest,
  keyGenerator: (req) => `ui-preferences:${req.user.id}`,
  handler: (req, res, next) => next(new RateLimitError()),
});

module.exports = { ACCOUNT_CHANGES_PER_HOUR, accountLimiter, UI_PREFERENCE_SAVES_PER_HOUR, uiPreferencesLimiter };
