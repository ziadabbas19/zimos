'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const {
  authLimiter,
  usernameCheckLimiter,
  verifyCodeLimiter,
  publicPlansLimiter,
  passwordResetLimiter,
  loginIpLimiter,
  authIpLimiter,
} = require('../../core/middleware/rateLimiters');
const controller = require('./authController');
const schemas = require('./authValidation');
const uiPreferences = require('./uiPreferences');

const router = Router();

// A sign-in that finishes marks the browser as known to the account, and alerts the person when it was
// not (newDeviceSignIn.js) - only while NEW_DEVICE_CODE or NEW_DEVICE_ALERT is on.
const env = require('../../config/env');
const newDevice = require('./newDeviceSignIn');
router.use((req, res, next) => (env.newDevice.code || env.newDevice.alert ? newDevice.attach(req, res, next) : next()));

// authIpLimiter / loginIpLimiter: per IP alone, on top of authLimiter
// (core/middleware/rateLimiters); sign-in counts failed attempts only.
router.post('/register', authIpLimiter, authLimiter, validate(schemas.register), controller.register);
// What the sign-up form must ask for right now (plan, terms, a code).
router.get('/signup-options', publicPlansLimiter, controller.signupOptions);
// Sign-up codes (REQUIRE_SIGNUP_VERIFICATION). The Bearer here is the
// verification token from sign-up or sign-in, which nothing else accepts.
router.post('/verify/send', verifyCodeLimiter, authLimiter, validate(schemas.verifySend), ...controller.sendVerificationCode);
router.post('/verify/confirm', verifyCodeLimiter, authLimiter, validate(schemas.verifyConfirm), ...controller.confirmVerificationCode);
router.post('/verify-email', authLimiter, validate(schemas.verifyEmail), controller.verifyEmail);
router.post('/resend-verification', authIpLimiter, authLimiter, validate(schemas.resendVerification), controller.resendVerification);
router.post('/login', loginIpLimiter, authLimiter, validate(schemas.login), controller.login);
router.get('/google', controller.googleRedirect);
router.get('/google/callback', authLimiter, validate(schemas.googleCallback), controller.googleCallback);
router.post('/refresh', authLimiter, validate(schemas.refresh), controller.refresh);
router.post('/logout', validate(schemas.logout), controller.logout);
router.post('/sessions/revoke-all', ...controller.revokeAllSessions);
router.get('/sessions', ...controller.listSessions);
router.get('/me', ...controller.me);
// Usernames: the sign-up form's live check (public, strict per-IP limit), and
// choosing or changing one's own.
router.get('/username-available', ...usernameCheckLimiter, validate(schemas.usernameAvailable), controller.usernameAvailable);
router.patch('/me/username', authLimiter, validate(schemas.changeUsername), ...controller.changeUsername);
// The account's own name, email and phone (auth/accountService), limited per
// account. An email or phone change needs the current password, or a code to
// the current email for an account without one, then a code to the new
// address. The phone change is closed unless PHONE_CHANGE_ENABLED.
router.patch('/me/name', validate(schemas.changeName), ...controller.changeName);
router.post('/me/reauth-code', validate(schemas.accountCode), ...controller.sendReauthCode);
router.post('/me/email-change', validate(schemas.emailChange), ...controller.requestEmailChange);
router.post('/me/email-change/confirm', validate(schemas.verifyConfirm), ...controller.confirmEmailChange);
router.post('/me/phone-change', validate(schemas.phoneChange), ...controller.requestPhoneChange);
router.post('/me/phone-change/confirm', validate(schemas.verifyConfirm), ...controller.confirmPhoneChange);
// Confirming a signed-in account's email with a code (the dashboard's
// banner): the sign-up codes' own limits, behind the same per-IP limiters.
router.post('/me/email/send-code', verifyCodeLimiter, authLimiter, validate(schemas.meEmailSend), ...controller.sendEmailCode);
router.post('/me/email/confirm', verifyCodeLimiter, authLimiter, validate(schemas.verifyConfirm), ...controller.confirmEmailCode);
router.post('/me/plan', authLimiter, validate(schemas.choosePlan), ...controller.choosePlan);
// The look of the dashboard (auth/uiPreferences), kept on the account so it
// follows its owner from one device to another. A save is small, strictly
// validated and limited per account on a counter of its own.
router.get('/me/ui-preferences', ...controller.getUiPreferences);
router.patch('/me/ui-preferences', uiPreferences.bodyLimit, validate(schemas.uiPreferences), ...controller.updateUiPreferences);
// Per IP per hour on its own key (authLimiter's includes the email sent);
// the per-account limit is in the database and silent.
router.post(
  '/password-reset/request',
  passwordResetLimiter,
  authIpLimiter,
  authLimiter,
  validate(schemas.requestPasswordReset),
  controller.requestPasswordReset
);
router.post('/password-reset/confirm', authLimiter, validate(schemas.resetPassword), controller.resetPassword);

// Phone verification (Bearer — the user is signed in right after registering).
router.post('/verify-phone/request', authLimiter, validate(schemas.verifyPhoneRequest), ...controller.requestPhoneVerification);
router.post('/verify-phone/confirm', authLimiter, validate(schemas.verifyPhoneConfirm), ...controller.confirmPhoneVerification);

// Password reset by SMS (public, enumeration-safe). Closed unless
// PASSWORD_RESET_SMS_ENABLED (authController's gates).
router.post(
  '/password-reset/sms/request',
  authLimiter,
  controller.smsResetRequestGate,
  validate(schemas.passwordResetSmsRequest),
  controller.requestPasswordResetSms
);
router.post(
  '/password-reset/sms/confirm',
  authLimiter,
  controller.smsResetConfirmGate,
  validate(schemas.passwordResetSmsConfirm),
  controller.resetPasswordSms
);

// Two-step sign-in (securityRoutes.js; TWO_FACTOR_ENABLED / NEW_DEVICE_CODE).
router.use(require('./securityRoutes'));

module.exports = router;
