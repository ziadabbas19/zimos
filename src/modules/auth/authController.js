'use strict';

const asyncHandler = require('express-async-handler');
const authService = require('./authService');
const { authenticate, authenticateAllowPending } = require('../../core/middleware/authenticate');
const { AppError } = require('../../core/errors/AppError');
const env = require('../../config/env');
const usernameService = require('../users/usernameService');
const signupPolicy = require('./signupPolicy');
const accountService = require('./accountService');
const uiPreferencesService = require('./uiPreferencesService');
const { accountLimiter, uiPreferencesLimiter } = require('../../core/middleware/accountLimiter');

const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body, req);
  res.status(201).json(result);
});

const verifyEmail = asyncHandler(async (req, res) => {
  const user = await authService.verifyEmail(req.body.token);
  res.json({ user });
});

const resendVerification = asyncHandler(async (req, res) => {
  const result = await authService.resendVerificationEmail(req.body.email);
  res.json(result);
});

const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, req);
  res.json(result);
});

// GET /auth/signup-options — public: what the sign-up form must ask for.
const signupOptions = asyncHandler(async (req, res) => {
  res.json(await signupPolicy.signupOptions());
});

// The verification token from sign-up (or a sign-in to an unconfirmed
// account), as a Bearer token. It opens these two endpoints and nothing else.
const authenticateVerification = asyncHandler(async (req, res, next) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new AppError('VERIFICATION_TOKEN_INVALID', 'Sign in again', 401);
  req.verificationUser = await signupPolicy.userForVerificationToken(token);
  next();
});

const sendVerificationCode = [
  authenticateVerification,
  asyncHandler(async (req, res) => {
    res.json(await authService.sendVerificationCode(req.verificationUser, req.body, req));
  }),
];

const confirmVerificationCode = [
  authenticateVerification,
  asyncHandler(async (req, res) => {
    res.json(await authService.confirmVerificationCode(req.verificationUser, req.body.code, req));
  }),
];

// A signed-in account confirming its email (the dashboard's banner).
const sendEmailCode = [
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await authService.sendAccountCode(req.user, req.body, req));
  }),
];

const confirmEmailCode = [
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await authService.confirmAccountCode(req.user, req.body.code, req));
  }),
];

// POST /auth/me/plan — the plan an account made through Google chooses.
const choosePlan = [
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await signupPolicy.choosePlan(req.user, req.body, req);
    res.json({ user: user.toSafeJSON(), needsPlan: await signupPolicy.needsPlan(user) });
  }),
];

// The OAuth state ties the callback to the browser that started the sign-in (googleState.js).
const googleRedirect = asyncHandler(async (req, res) => {
  res.redirect(authService.getGoogleAuthUrl(require('./googleState').issue(res)));
});

const googleCallback = asyncHandler(async (req, res) => {
  const back = (params) => res.redirect(`${env.frontendUrl}/auth/callback?${new URLSearchParams(params).toString()}`);

  const stateOk = require('./googleState').consume(req, res);
  if (req.query.error) return back({ error: req.query.error });
  // Not started from this browser, or started over 10 minutes ago.
  if (!stateOk) return back({ error: 'GOOGLE_STATE_MISMATCH' });

  try {
    const result = await authService.loginWithGoogle(req.query.code, req);
    // Two-step sign-in on: the dashboard asks for the code and finishes with
    // POST /auth/two-factor/verify, as after a password sign-in.
    if (result.twoFactorRequired) {
      const params = {};
      for (const [k, v] of Object.entries(result)) if (['string', 'boolean', 'number'].includes(typeof v)) params[k] = String(v);
      return back(params);
    }
    const { accessToken, refreshToken } = result;
    return back({ accessToken, refreshToken });
  } catch (err) {
    if (err instanceof AppError) return back({ error: err.code || 'GOOGLE_LOGIN_FAILED' });
    throw err;
  }
});

const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body.refreshToken, req);
  res.json(result);
});

const logout = asyncHandler(async (req, res) => {
  const result = await authService.logout(req.body.refreshToken);
  res.json(result);
});

const revokeAllSessions = [
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await authService.revokeAllSessions(req.user.id, req);
    res.json(result);
  }),
];

const listSessions = [
  authenticate,
  asyncHandler(async (req, res) => {
    const sessions = await authService.listSessions(req.user.id);
    res.json({ sessions });
  }),
];

// `suggestedUsername` only for an account with no username yet (made through
// Google): the dashboard asks its owner to pick one, starting from this.
// `needsPlan`: an account made through Google while a plan is required, that
// has not chosen one — the dashboard asks for it before anything else.
// `confirmed`: its email (or phone) is confirmed; until it is, starting a
// trial and publishing are refused and the dashboard shows its banner.
const me = [
  authenticate,
  asyncHandler(async (req, res) => {
    const user = req.user.toSafeJSON();
    const needsPlan = await signupPolicy.needsPlan(req.user);
    const confirmed = signupPolicy.isVerified(req.user);
    // What the account settings can offer: a password to confirm changes
    // with (else a code to the current email), and the phone change switch.
    const account = { hasPassword: Boolean(req.user.passwordHash), phoneChange: env.account.phoneChangeEnabled === true };
    if (user.username) return res.json({ user, needsPlan, confirmed, account });
    return res.json({ user, needsPlan, confirmed, account, suggestedUsername: await usernameService.suggestFor(user.email) });
  }),
];

// GET /auth/username-available?u= — public, tightly rate limited per IP.
const usernameAvailable = asyncHandler(async (req, res) => {
  res.json(await usernameService.availability(req.query.u));
});

// --- Account settings (auth/accountService): always the signed-in account's own.

const changeName = [
  authenticate,
  accountLimiter,
  asyncHandler(async (req, res) => {
    const user = await accountService.changeName(req.user, req.body.fullName, req);
    res.json({ user: user.toSafeJSON() });
  }),
];

const sendReauthCode = [
  authenticate,
  accountLimiter,
  asyncHandler(async (req, res) => {
    res.json({ sent: true, ...(await accountService.sendReauthCode(req.user, req.body, req)) });
  }),
];

const requestEmailChange = [
  authenticate,
  accountLimiter,
  asyncHandler(async (req, res) => {
    res.json({ sent: true, ...(await accountService.requestEmailChange(req.user, req.body, req)) });
  }),
];

const confirmEmailChange = [
  authenticate,
  accountLimiter,
  asyncHandler(async (req, res) => {
    res.json(await accountService.confirmEmailChange(req.user, req.body.code, req));
  }),
];

const requestPhoneChange = [
  authenticate,
  accountLimiter,
  asyncHandler(async (req, res) => {
    res.json({ sent: true, ...(await accountService.requestPhoneChange(req.user, req.body, req)) });
  }),
];

const confirmPhoneChange = [
  authenticate,
  accountLimiter,
  asyncHandler(async (req, res) => {
    res.json(await accountService.confirmPhoneChange(req.user, req.body.code, req));
  }),
];

// PATCH /auth/me/username — the first choice, or a change (once per 30 days).
const changeUsername = [
  authenticate,
  accountLimiter,
  asyncHandler(async (req, res) => {
    const user = await usernameService.changeUsername(req.user.id, req.body.username, req);
    res.json({ user: user.toSafeJSON() });
  }),
];

// --- The look of the dashboard, saved to the account (auth/uiPreferencesService):
// always the signed-in account's own.

// GET /auth/me/ui-preferences — null until the account saves something.
const getUiPreferences = [
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ uiPreferences: await uiPreferencesService.read(req.user.id) });
  }),
];

// PATCH /auth/me/ui-preferences — the appearance part, whole.
const updateUiPreferences = [
  authenticate,
  uiPreferencesLimiter,
  asyncHandler(async (req, res) => {
    res.json({ uiPreferences: await uiPreferencesService.saveAppearance(req.user.id, req.body.appearance) });
  }),
];

const requestPasswordReset = asyncHandler(async (req, res) => {
  const result = await authService.requestPasswordReset(req.body.email, { locale: req.body.locale });
  res.json(result);
});

const resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.body.token, req.body.newPassword, req);
  res.json(result);
});

const requestPhoneVerification = [
  authenticateAllowPending,
  asyncHandler(async (req, res) => {
    const result = await authService.requestPhoneVerification(req.user.id, req.body.phone);
    res.json(result);
  }),
];

const confirmPhoneVerification = [
  authenticateAllowPending,
  asyncHandler(async (req, res) => {
    const result = await authService.confirmPhoneVerification(req.user, req.body.phone, req.body.code, req);
    res.json(result);
  }),
];

// Password reset by SMS stays closed unless PASSWORD_RESET_SMS_ENABLED is
// "true" (env.passwordReset): the dashboard has no screen for it, and its
// sending limit could tell a verified number apart. Closed, the request
// answers success for any number and sends nothing, as it does for a number
// with no account; the confirmation answers as a wrong code does.
function smsResetRequestGate(req, res, next) {
  if (env.passwordReset.smsEnabled) return next();
  return res.json({ success: true });
}

function smsResetConfirmGate(req, res, next) {
  if (env.passwordReset.smsEnabled) return next();
  return next(new AppError('INVALID_CODE', 'That code is not valid', 422));
}

const requestPasswordResetSms = asyncHandler(async (req, res) => {
  const result = await authService.requestPasswordResetSms(req.body.phone);
  res.json(result);
});

const resetPasswordSms = asyncHandler(async (req, res) => {
  const result = await authService.resetPasswordSms(req.body.phone, req.body.code, req.body.newPassword);
  res.json(result);
});

module.exports = {
  register,
  signupOptions,
  sendVerificationCode,
  confirmVerificationCode,
  sendEmailCode,
  confirmEmailCode,
  choosePlan,
  verifyEmail,
  resendVerification,
  login,
  googleRedirect,
  googleCallback,
  refresh,
  logout,
  revokeAllSessions,
  listSessions,
  me,
  usernameAvailable,
  changeUsername,
  changeName,
  sendReauthCode,
  requestEmailChange,
  confirmEmailChange,
  requestPhoneChange,
  confirmPhoneChange,
  getUiPreferences,
  updateUiPreferences,
  requestPasswordReset,
  resetPassword,
  requestPhoneVerification,
  confirmPhoneVerification,
  smsResetRequestGate,
  smsResetConfirmGate,
  requestPasswordResetSms,
  resetPasswordSms,
};
