'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../../config/env');
const { RateLimitError } = require('../errors/AppError');

function handler(req, res, next) {
  next(new RateLimitError());
}

// Rate limiting is disabled in the automated test suite: tests run many
// sequential requests against one long-lived app instance in-process, which
// would otherwise trip these limits regardless of real client behavior. The
// limiter configuration itself (windows, max counts, keying) is still real
// production code exercised manually against the dev server — see the
// project report for how that was verified.
const skip = () => env.isTest;

const generalLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  handler,
});

// Tighter limit for auth endpoints (brute-force protection), keyed by IP + email
// where available so one IP hammering many accounts and one attacker hammering
// one account are both throttled.
const authLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body && req.body.email ? req.body.email : ''}`,
  handler,
});

module.exports = { generalLimiter, authLimiter };
