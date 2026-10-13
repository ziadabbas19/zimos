'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { authLimiter, authIpLimiter } = require('../../core/middleware/rateLimiters');
const { AppError } = require('../../core/errors/AppError');
const authService = require('./authService');
const twoFactor = require('./twoFactorService');

/**
 * Two-step sign-in, mounted inside the auth router (/api/v1/auth). The
 * settings answer 404 TWO_FACTOR_UNAVAILABLE while TWO_FACTOR_ENABLED is off;
 * the second step itself (POST /two-factor/verify) also works while only
 * NEW_DEVICE_CODE is on, since a new browser's email code is finished there.
 */

const router = Router();

/** "Chrome on Windows" from a User-Agent, without a dependency. */
function describeAgent(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return { browser: null, os: null };
  const browser =
    (/Edg\//.test(ua) && 'Edge') ||
    (/OPR\/|Opera/.test(ua) && 'Opera') ||
    (/SamsungBrowser/.test(ua) && 'Samsung Internet') ||
    (/Chrome\//.test(ua) && 'Chrome') ||
    (/Firefox\//.test(ua) && 'Firefox') ||
    (/Safari\//.test(ua) && 'Safari') ||
    (/node|curl|axios|okhttp|Dart/i.test(ua) && 'App or script') ||
    null;
  const os =
    (/Android/.test(ua) && 'Android') ||
    (/iPhone|iPad|iPod/.test(ua) && 'iOS') ||
    (/Windows/.test(ua) && 'Windows') ||
    (/Mac OS X/.test(ua) && 'macOS') ||
    (/Linux/.test(ua) && 'Linux') ||
    null;
  return { browser, os };
}

const unavailable = () => new AppError('TWO_FACTOR_UNAVAILABLE', 'Two-step sign-in is not available', 404);
const settingsOn = (req, res, next) => (env.twoFactor.enabled ? next() : next(unavailable()));
const stepOn = (req, res, next) => (env.twoFactor.enabled || env.newDevice.code ? next() : next(unavailable()));

// Backup codes (twoFactorRecovery.js).
router.use('/two-factor/backup-codes', settingsOn);
router.use(require('./twoFactorRecovery').router);

// The settings below that re-check the password also count per IP alone
// (authIpLimiter): authLimiter's own bucket follows whatever account the body names.
const password = Joi.string().max(200).allow('', null).optional();
const code = Joi.string().trim().min(6).max(10).required();

router.get('/two-factor', settingsOn, authenticate, asyncHandler(async (req, res) => res.json(await twoFactor.status(req.user))));

router.post(
  '/two-factor/email/enable',
  settingsOn,
  authIpLimiter,
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.enableEmail(req.user, req.body, req)))
);

// The code on WhatsApp to the verified phone (twoFactorWhatsapp.js).
router.post(
  '/two-factor/whatsapp/enable',
  settingsOn,
  authIpLimiter,
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.enableWhatsapp(req.user, req.body, req)))
);

router.post(
  '/two-factor/totp/setup',
  settingsOn,
  authIpLimiter,
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.setupTotp(req.user, req.body)))
);

router.post(
  '/two-factor/totp/confirm',
  settingsOn,
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ code }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.confirmTotp(req.user, req.body, req)))
);

router.post(
  '/two-factor/disable',
  settingsOn,
  authIpLimiter,
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password }) }),
  asyncHandler(async (req, res) => res.json(await twoFactor.disable(req.user, req.body, req)))
);

router.post(
  '/two-factor/forget-devices',
  settingsOn,
  authenticate,
  asyncHandler(async (req, res) => res.json(await twoFactor.forgetDevices(req.user, req)))
);

// The second step of a sign-in that answered { twoFactorRequired }. Public:
// the challenge token is what identifies the attempt.
router.post(
  '/two-factor/verify',
  stepOn,
  authLimiter,
  validate({
    body: Joi.object({
      challengeToken: Joi.string().uuid().required(),
      code,
      rememberDevice: Joi.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const user = await twoFactor.verifyChallenge(req.body, req, res);
    res.json(await authService.completeLogin(user, req));
  })
);

module.exports = router;
// "Chrome on Windows" for the new sign-in alert (newDeviceSignIn.js).
module.exports.describeAgent = describeAgent;
