'use strict';

const db = require('../../db/models');
const { hashPassword, verifyPassword } = require('../../core/security/password');
const {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  generateOpaqueToken,
} = require('../../core/security/tokens');
const { AppError, AuthenticationError, ConflictError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');
const googleClient = require('./googleClient');
const otpService = require('../otp/otpService');
const { normalizePhone } = require('../../core/utils/phone');

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function issueTokenPair(user, req) {
  const accessToken = signAccessToken({ sub: user.id });
  return createSession(user, req).then(({ raw, session }) => ({
    accessToken,
    refreshToken: raw,
    sessionId: session.id,
    expiresAt: session.expiresAt,
  }));
}

async function createSession(user, req) {
  const { raw, hash } = generateRefreshToken();
  const session = await db.Session.create({
    userId: user.id,
    refreshTokenHash: hash,
    userAgent: req ? req.headers['user-agent'] : null,
    ipAddress: req ? req.ip : null,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return { raw, session };
}

async function register({ email, password, fullName, phone }, req) {
  const existing = await db.User.findOne({ where: { email } });
  if (existing) {
    throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
  }

  const passwordHash = await hashPassword(password);
  const user = await db.User.create({ email, passwordHash, fullName, phone });

  const rawToken = generateOpaqueToken();
  await db.VerificationToken.create({
    userId: user.id,
    type: 'email_verification',
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
  });

  await notify.email({
    recipient: user.email,
    template: 'email_verification',
    data: { token: rawToken, fullName: user.fullName },
  });

  await recordAudit({ actorUserId: user.id, action: 'user.register', entityType: 'User', entityId: user.id, req });

  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

async function verifyEmail(rawToken) {
  const tokenHash = hashToken(rawToken);
  const record = await db.VerificationToken.findOne({
    where: { tokenHash, type: 'email_verification' },
  });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new AppError('INVALID_VERIFICATION_TOKEN', 'Verification token is invalid or expired', 400);
  }
  await record.update({ usedAt: new Date() });
  const user = await db.User.findByPk(record.userId);
  await user.update({ status: 'active', emailVerifiedAt: new Date() });
  return user.toSafeJSON();
}

async function login({ email, password }, req) {
  const user = await db.User.findOne({ where: { email } });
  // Same error for "no such user" and "wrong password" — never reveal which
  // one it was, to avoid account enumeration via the login endpoint.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new AuthenticationError('Invalid email or password', 'INVALID_CREDENTIALS');
  }
  if (user.status === 'suspended') {
    throw new AuthenticationError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  await user.update({ lastLoginAt: new Date() });
  await recordAudit({ actorUserId: user.id, action: 'user.login', entityType: 'User', entityId: user.id, req });

  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

/** URL to send the browser to for Google's consent screen. */
function getGoogleAuthUrl() {
  return googleClient.getAuthUrl();
}

/**
 * Complete a Google OAuth login from the `code` Google redirected back with.
 * - known googleId  -> log that user in
 * - known email     -> link googleId to that account, then log in
 * - neither         -> create a new active, email-verified, passwordless user
 */
async function loginWithGoogle(code, req) {
  const profile = await googleClient.fetchProfile(code);
  if (!profile.googleId || !profile.email) {
    throw new AuthenticationError('Google did not return a usable profile', 'GOOGLE_PROFILE_INCOMPLETE');
  }

  let user = await db.User.findOne({ where: { googleId: profile.googleId } });
  let action = 'user.login.google';

  if (!user) {
    const byEmail = await db.User.findOne({ where: { email: profile.email } });
    if (byEmail) {
      await byEmail.update({ googleId: profile.googleId });
      user = byEmail;
      action = 'user.link.google';
    } else {
      user = await db.User.create({
        email: profile.email,
        googleId: profile.googleId,
        fullName: profile.fullName,
        passwordHash: null,
        status: 'active',
        emailVerifiedAt: new Date(),
      });
      action = 'user.register.google';
    }
  }

  if (user.status === 'suspended') {
    throw new AuthenticationError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  await user.update({ lastLoginAt: new Date() });
  await recordAudit({ actorUserId: user.id, action, entityType: 'User', entityId: user.id, req });

  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

/**
 * Refresh-token rotation: the presented raw token must hash-match an active,
 * non-revoked, non-expired Session. On success, that session is revoked and
 * immediately replaced by a brand new one (rotatedToSessionId links them),
 * and a fresh raw refresh token is returned. Presenting an already-rotated
 * (revoked) token is treated as a possible theft signal and revokes the
 * entire chain, not just the one session.
 */
async function refresh(rawRefreshToken, req) {
  const tokenHash = hashToken(rawRefreshToken);
  const session = await db.Session.findOne({ where: { refreshTokenHash: tokenHash } });

  if (!session) {
    throw new AuthenticationError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }

  if (session.revokedAt) {
    // Reuse of a rotated-away token: revoke every session for this user as a
    // precaution against a stolen refresh token being replayed.
    await db.Session.update(
      { revokedAt: new Date() },
      { where: { userId: session.userId, revokedAt: null } }
    );
    throw new AuthenticationError('Refresh token has already been used — all sessions revoked', 'REFRESH_TOKEN_REUSE_DETECTED');
  }

  if (session.expiresAt < new Date()) {
    throw new AuthenticationError('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
  }

  const user = await db.User.findByPk(session.userId);
  if (!user || user.status !== 'active') {
    throw new AuthenticationError('Account is not active', 'ACCOUNT_INACTIVE');
  }

  const { raw, session: newSession } = await createSession(user, req);
  await session.update({ revokedAt: new Date(), rotatedToSessionId: newSession.id });

  const accessToken = signAccessToken({ sub: user.id });
  return { accessToken, refreshToken: raw, sessionId: newSession.id, expiresAt: newSession.expiresAt };
}

async function logout(rawRefreshToken) {
  const tokenHash = hashToken(rawRefreshToken);
  const session = await db.Session.findOne({ where: { refreshTokenHash: tokenHash } });
  if (session && !session.revokedAt) {
    await session.update({ revokedAt: new Date() });
  }
  return { success: true };
}

async function revokeAllSessions(userId, req) {
  await db.Session.update({ revokedAt: new Date() }, { where: { userId, revokedAt: null } });
  await recordAudit({ actorUserId: userId, action: 'user.revoke_all_sessions', entityType: 'User', entityId: userId, req });
  return { success: true };
}

async function listSessions(userId) {
  const sessions = await db.Session.findAll({ where: { userId }, order: [['createdAt', 'DESC']] });
  return sessions.map((s) => ({
    id: s.id,
    userAgent: s.userAgent,
    ipAddress: s.ipAddress,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    revokedAt: s.revokedAt,
    isActive: s.isActive(),
  }));
}

async function requestPasswordReset(email) {
  const user = await db.User.findOne({ where: { email } });
  // Always behave the same way whether the account exists or not, so this
  // endpoint can't be used to enumerate registered emails.
  if (user) {
    const rawToken = generateOpaqueToken();
    await db.VerificationToken.create({
      userId: user.id,
      type: 'password_reset',
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
    await notify.email({
      recipient: user.email,
      template: 'password_reset',
      data: { token: rawToken, fullName: user.fullName },
    });
  }
  return { success: true };
}

async function resetPassword(rawToken, newPassword) {
  const tokenHash = hashToken(rawToken);
  const record = await db.VerificationToken.findOne({ where: { tokenHash, type: 'password_reset' } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw new AppError('INVALID_RESET_TOKEN', 'Password reset token is invalid or expired', 400);
  }
  const user = await db.User.findByPk(record.userId);
  if (!user) throw new AppError('INVALID_RESET_TOKEN', 'Password reset token is invalid or expired', 400);

  await user.update({ passwordHash: await hashPassword(newPassword) });
  await record.update({ usedAt: new Date() });
  // A password reset is a strong signal the account may have been
  // compromised — revoke every existing session so old refresh tokens
  // (possibly in an attacker's hands) stop working immediately.
  await db.Session.update({ revokedAt: new Date() }, { where: { userId: user.id, revokedAt: null } });
  await recordAudit({ actorUserId: user.id, action: 'user.password_reset', entityType: 'User', entityId: user.id });

  return { success: true };
}

// --- Phone verification (during/after registration) ----------------------

async function requestPhoneVerification(userId, phone) {
  await otpService.generateAndSendOtp(phone, 'phone_verification');
  return { sent: true };
}

async function confirmPhoneVerification(user, phone, code, req) {
  await otpService.verifyOtp(phone, 'phone_verification', code);
  await user.update({ phone: normalizePhone(phone), phoneVerifiedAt: new Date() });
  await recordAudit({ actorUserId: user.id, action: 'user.phone_verified', entityType: 'User', entityId: user.id, req });
  return { user: user.toSafeJSON() };
}

// --- Password reset by SMS ------------------------------------------------

async function requestPasswordResetSms(phone) {
  const normalized = normalizePhone(phone);
  const user = normalized ? await db.User.findOne({ where: { phone: normalized } }) : null;
  // Enumeration-safe: same response whether or not a verified phone matches.
  if (user && user.phoneVerifiedAt) {
    await otpService.generateAndSendOtp(phone, 'password_reset');
  }
  return { success: true };
}

async function resetPasswordSms(phone, code, newPassword) {
  await otpService.verifyOtp(phone, 'password_reset', code);
  const normalized = normalizePhone(phone);
  const user = await db.User.findOne({ where: { phone: normalized } });
  if (!user) throw new AppError('INVALID_CODE', 'That code is not valid', 422);

  await user.update({ passwordHash: await hashPassword(newPassword) });
  await db.Session.update({ revokedAt: new Date() }, { where: { userId: user.id, revokedAt: null } });
  await recordAudit({ actorUserId: user.id, action: 'user.password_reset_sms', entityType: 'User', entityId: user.id });
  return { success: true };
}

module.exports = {
  register,
  verifyEmail,
  login,
  getGoogleAuthUrl,
  loginWithGoogle,
  refresh,
  logout,
  revokeAllSessions,
  listSessions,
  requestPasswordReset,
  resetPassword,
  requestPhoneVerification,
  confirmPhoneVerification,
  requestPasswordResetSms,
  resetPasswordSms,
};
