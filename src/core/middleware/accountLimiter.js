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

/*
 * Phone-verification codes (POST /auth/verify-phone/request). Each one is an
 * SMS the platform pays for, to a number the caller types: the per-phone limit
 * in otp/otpService is spent on that number, so naming a new one each time got
 * a new allowance. Per account a day, on a counter of its own, whatever
 * numbers are named; a request that sent nothing (4xx, 5xx) is not counted.
 */
const PHONE_VERIFICATION_CODES_PER_DAY = 5;

function createPhoneVerificationLimiter({ max = PHONE_VERIFICATION_CODES_PER_DAY, skip = () => env.isTest } = {}) {
  return rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
    skip,
    keyGenerator: (req) => `phone-verification:${req.user.id}`,
    handler: (req, res, next) => next(new RateLimitError()),
  });
}

const phoneVerificationLimiter = createPhoneVerificationLimiter();

/*
 * Test notifications to one's own devices (POST /me/push/test,
 * notifications/push): each one is a request to a push service, so a few a
 * minute per account, on a counter of their own.
 */
const PUSH_TESTS_PER_MINUTE = 5;

function createPushTestLimiter({ max = PUSH_TESTS_PER_MINUTE, skip = () => env.isTest } = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    keyGenerator: (req) => `push-test:${req.user.id}`,
    handler: (req, res, next) => next(new RateLimitError()),
  });
}

const pushTestLimiter = createPushTestLimiter();

module.exports = {
  ACCOUNT_CHANGES_PER_HOUR,
  accountLimiter,
  UI_PREFERENCE_SAVES_PER_HOUR,
  uiPreferencesLimiter,
  PHONE_VERIFICATION_CODES_PER_DAY,
  phoneVerificationLimiter,
  createPhoneVerificationLimiter,
  PUSH_TESTS_PER_MINUTE,
  pushTestLimiter,
  createPushTestLimiter,
};
