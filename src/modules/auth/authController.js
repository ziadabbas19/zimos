'use strict';

const asyncHandler = require('express-async-handler');
const authService = require('./authService');
const { authenticate, authenticateAllowPending } = require('../../core/middleware/authenticate');
const { AppError } = require('../../core/errors/AppError');
const env = require('../../config/env');

const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body, req);
  res.status(201).json(result);
});

const verifyEmail = asyncHandler(async (req, res) => {
  const user = await authService.verifyEmail(req.body.token);
  res.json({ user });
});

const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, req);
  res.json(result);
});

const googleRedirect = asyncHandler(async (req, res) => {
  res.redirect(authService.getGoogleAuthUrl());
});

const googleCallback = asyncHandler(async (req, res) => {
  const back = (params) => res.redirect(`${env.frontendUrl}/auth/callback?${new URLSearchParams(params).toString()}`);

  if (req.query.error) return back({ error: req.query.error });

  try {
    const { accessToken, refreshToken } = await authService.loginWithGoogle(req.query.code, req);
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

const me = [
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user.toSafeJSON() });
  }),
];

const requestPasswordReset = asyncHandler(async (req, res) => {
  const result = await authService.requestPasswordReset(req.body.email);
  res.json(result);
});

const resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.body.token, req.body.newPassword);
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
  verifyEmail,
  login,
  googleRedirect,
  googleCallback,
  refresh,
  logout,
  revokeAllSessions,
  listSessions,
  me,
  requestPasswordReset,
  resetPassword,
  requestPhoneVerification,
  confirmPhoneVerification,
  requestPasswordResetSms,
  resetPasswordSms,
};
