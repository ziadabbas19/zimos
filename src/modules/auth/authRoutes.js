'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authLimiter } = require('../../core/middleware/rateLimiters');
const controller = require('./authController');
const schemas = require('./authValidation');

const router = Router();

router.post('/register', authLimiter, validate(schemas.register), controller.register);
router.post('/verify-email', authLimiter, validate(schemas.verifyEmail), controller.verifyEmail);
router.post('/login', authLimiter, validate(schemas.login), controller.login);
router.get('/google', controller.googleRedirect);
router.get('/google/callback', authLimiter, validate(schemas.googleCallback), controller.googleCallback);
router.post('/refresh', authLimiter, validate(schemas.refresh), controller.refresh);
router.post('/logout', validate(schemas.logout), controller.logout);
router.post('/sessions/revoke-all', ...controller.revokeAllSessions);
router.get('/sessions', ...controller.listSessions);
router.get('/me', ...controller.me);
router.post(
  '/password-reset/request',
  authLimiter,
  validate(schemas.requestPasswordReset),
  controller.requestPasswordReset
);
router.post('/password-reset/confirm', authLimiter, validate(schemas.resetPassword), controller.resetPassword);

// Phone verification (Bearer — the user is signed in right after registering).
router.post('/verify-phone/request', authLimiter, validate(schemas.verifyPhoneRequest), ...controller.requestPhoneVerification);
router.post('/verify-phone/confirm', authLimiter, validate(schemas.verifyPhoneConfirm), ...controller.confirmPhoneVerification);

// Password reset by SMS (public, enumeration-safe).
router.post(
  '/password-reset/sms/request',
  authLimiter,
  validate(schemas.passwordResetSmsRequest),
  controller.requestPasswordResetSms
);
router.post(
  '/password-reset/sms/confirm',
  authLimiter,
  validate(schemas.passwordResetSmsConfirm),
  controller.resetPasswordSms
);

module.exports = router;
