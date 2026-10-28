'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { ipKeyGenerator } = require('express-rate-limit');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const { clientIp } = require('../../core/middleware/clientIp');
const { hashPassword, verifyPassword } = require('../../core/security/password');
const {
  signAccessToken,
  generateRefreshToken,
  hashToken,
  generateOpaqueToken,
} = require('../../core/security/tokens');
const { AppError, AuthenticationError, ConflictError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const sessionGate = require('../../core/security/sessionGate');
const pushSessions = require('../notifications/push/pushSessions');
const notify = require('../notifications/notify');
const googleClient = require('./googleClient');
const otpService = require('../otp/otpService');
const { normalizePhone } = require('../../core/utils/phone');
const usernameService = require('../users/usernameService');
const { isUsernameConflict } = require('../users/username');
const signupPolicy = require('./signupPolicy');
const siteTraffic = require('../siteAnalytics/siteTrafficService');
const verificationCodes = require('../otp/verificationCodeService');

const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Reset emails one account may get; past them a request still answers the
// same, it just sends nothing.
const PASSWORD_RESET_LIMITS = Object.freeze({ perHour: 3, perDay: 10 });

function issueTokenPair(user, req) {
  return createSession(user, req).then(({ raw, session }) => ({
    // The access token names its session (`sid`): ending the session ends it too (core/security/sessionGate).
    accessToken: signAccessToken({ sub: user.id, sid: session.id }),
    refreshToken: raw,
    sessionId: session.id,
    expiresAt: session.expiresAt,
  }));
}

/**
 * How long a session made now lasts (SESSION_TTL_DAYS, 30 unless set). An
 * account with a platform role gets the console's own length
 * (SESSION_TTL_DAYS_CONSOLE), in the dashboard too. A refresh makes a new
 * session, so the count starts again at every refresh.
 */
function sessionTtlMs(user) {
  return (user.platformRole ? env.session.consoleTtlDays : env.session.ttlDays) * DAY_MS;
}

// `id` and `transaction` are for a rotation (refresh): the session that
// replaces another is named before it exists and written with the other's end.
async function createSession(user, req, { id = null, transaction = null } = {}) {
  const { raw, hash } = generateRefreshToken();
  const session = await db.Session.create(
    {
      ...(id ? { id } : {}),
      userId: user.id,
      refreshTokenHash: hash,
      userAgent: req ? req.headers['user-agent'] : null,
      ipAddress: req ? clientIp(req) : null,
      expiresAt: new Date(Date.now() + sessionTtlMs(user)),
    },
    transaction ? { transaction } : {}
  );
  return { raw, session };
}

/**
 * The account row, with its username. A chosen username that someone else
 * holds — checked here, and again by the unique index for two sign-ups racing
 * for it — is 409 USERNAME_TAKEN. With none given (a client from before
 * usernames: the dashboard deployed before this API asks for one) the account
 * gets one made from the email, as existing accounts did (migration 124).
 */
async function createAccount({ email, passwordHash, fullName, phone, username, extra = {} }) {
  if (username) {
    if (await usernameService.isTaken(username)) throw usernameService.takenError();
    try {
      return await db.User.create({ email, passwordHash, fullName, phone, username, ...extra });
    } catch (err) {
      if (isUsernameConflict(err)) throw usernameService.takenError();
      throw err;
    }
  }
  for (let attempt = 0; ; attempt += 1) {
    const generated = await usernameService.suggestFor(email);
    try {
      return await db.User.create({ email, passwordHash, fullName, phone, username: generated, ...extra });
    } catch (err) {
      if (!isUsernameConflict(err) || attempt >= 4) throw err;
    }
  }
}

/**
 * The 6-digit code that confirms a new account's email, sent at sign-up while
 * sign-up codes are off. The account is already signed in, so nothing here
 * may fail the sign-up: no email provider, a sending limit reached or a
 * provider error just means no code went out — the dashboard's banner offers
 * to send one.
 */
async function sendSignupCode(user, { locale, req }) {
  if (!verificationCodes.emailReady()) return { sent: false };
  try {
    const sent = await verificationCodes.sendCode(user, 'email', { ip: req ? clientIp(req) : null, locale, req });
    return { sent: true, ...sent };
  } catch (err) {
    if (!(err instanceof AppError)) logger.error('Could not send the sign-up code', { userId: user.id, message: err.message });
    return { sent: false };
  }
}

/**
 * Email/password sign-up. The plan, terms and code rules are
 * auth/signupPolicy's.
 *
 * With sign-up codes on (REQUIRE_SIGNUP_VERIFICATION), no tokens until the
 * code is typed back. Off, the account is active and signed in at once, its
 * email not confirmed yet: a code to confirm it is emailed, and until it is,
 * starting a trial and publishing are refused (core/middleware/confirmedAccount).
 */
async function register({ email, password, fullName, phone, username, planId, billingCycle, acceptTerms, locale, siteSessionId }, req) {
  const existing = await db.User.findOne({ where: { email } });
  if (existing) {
    throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
  }

  const extra = await signupPolicy.registrationFields({ email, planId, billingCycle, acceptTerms });
  const verifying = signupPolicy.verificationRequired();
  if (verifying) {
    // Fail closed: a code nobody can receive would lock the account out.
    if (!verificationCodes.emailReady()) {
      throw new AppError('SIGNUP_UNAVAILABLE', 'Sign-up is not available right now. Try again later.', 503);
    }
    // Checked before the account exists, so one address or IP cannot mint
    // accounts past the code limits.
    await verificationCodes.assertCanSend({ channel: 'email', target: String(email).toLowerCase(), ip: req ? clientIp(req) : null });
  }

  const passwordHash = await hashPassword(password);
  const user = await createAccount({
    email,
    passwordHash,
    fullName,
    phone,
    username,
    extra: verifying ? extra : { ...extra, status: 'active' },
  });
  await recordAudit({ actorUserId: user.id, action: 'user.register', entityType: 'User', entityId: user.id, req });
  // Never throws: analytics cannot fail a sign-up.
  await siteTraffic.linkSignup(user.id, siteSessionId);

  if (verifying) {
    const sent = await verificationCodes.sendCode(user, 'email', { ip: req ? clientIp(req) : null, locale, req });
    return signupPolicy.verificationResponse(user, sent);
  }

  const emailCode = await sendSignupCode(user, { locale, req });
  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens, emailCode };
}

async function verifyEmail(rawToken) {
  const tokenHash = hashToken(rawToken);
  // One transaction, with the token row locked, so the account is activated
  // and the token burned atomically: a failure half-way can't leave the user
  // still `pending_verification` *and* their token spent (which would force a
  // fresh "resend" every time), and two concurrent submissions of the same
  // token can't both pass the used/expired check.
  return db.sequelize.transaction(async (t) => {
    const record = await db.VerificationToken.findOne({
      where: { tokenHash, type: 'email_verification' },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError('INVALID_VERIFICATION_TOKEN', 'Verification token is invalid or expired', 400);
    }
    const user = await db.User.findByPk(record.userId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!user || user.deletedAt) {
      throw new AppError('INVALID_VERIFICATION_TOKEN', 'Verification token is invalid or expired', 400);
    }
    // The link confirms an address; it activates only an account still waiting
    // for that. A suspended account stays suspended: a link sent before the
    // suspension must not undo it (the same rule as resetPassword).
    await user.update(
      { emailVerifiedAt: new Date(), ...(user.status === 'pending_verification' ? { status: 'active' } : {}) },
      { transaction: t }
    );
    await record.update({ usedAt: new Date() }, { transaction: t });
    return user.toSafeJSON();
  });
}

async function resendVerificationEmail(email) {
  const user = await db.User.findOne({ where: { email } });
  // Enumeration-safe: identical `{ success: true }` response whether the
  // account doesn't exist, is already verified/active, or is suspended.
  // Only a still-pending account actually triggers an email.
  if (user && user.status === 'pending_verification') {
    // Invalidate every previous unused email-verification token for this
    // user so only the link we're about to send will work.
    await db.VerificationToken.update(
      { usedAt: new Date() },
      { where: { userId: user.id, type: 'email_verification', usedAt: null } }
    );

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
  }
  return { success: true };
}

/**
 * The account a sign-in names: by email when what was typed has an "@" (a
 * username never has one; users.email is case-insensitive), otherwise by
 * username, which is stored lower-case.
 */
async function findForSignIn({ identifier, email }) {
  const given = String(identifier || email || '').trim();
  if (!given) return null;
  if (given.includes('@')) return db.User.findOne({ where: { email: given } });
  return db.User.findOne({
    where: db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('username')), given.toLowerCase()),
  });
}

// Compared against when no account matches, so "no such account" costs the
// same bcrypt work as "wrong password" and the timing doesn't tell them apart.
let dummyHash = null;
const getDummyHash = () => {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(24).toString('hex'));
  return dummyHash;
};

async function login({ identifier, email, password, locale }, req) {
  const user = await findForSignIn({ identifier, email });
  // Same error for "no such account" and "wrong password" — never reveal which
  // one it was, to avoid account enumeration via the login endpoint.
  let passwordOk = false;
  if (user && user.passwordHash) passwordOk = await verifyPassword(password, user.passwordHash);
  else await verifyPassword(password, await getDummyHash());
  if (!passwordOk) {
    throw new AuthenticationError('Invalid sign-in details', 'INVALID_CREDENTIALS');
  }
  if (user.deletedAt) throw new AuthenticationError('This account was deleted', 'ACCOUNT_DELETED');
  if (user.status === 'suspended') {
    throw new AuthenticationError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  }

  // With sign-up codes on, an account not confirmed yet is sent to its code
  // (a fresh one, unless one went out moments ago) instead of being signed
  // in; one confirmed some other way is let in.
  if (signupPolicy.verificationRequired()) {
    if (!signupPolicy.isVerified(user)) {
      let sent = null;
      try {
        sent = await verificationCodes.sendCode(user, 'email', { ip: req ? clientIp(req) : null, locale, req });
      } catch (err) {
        if (!(err instanceof AppError) || err.statusCode !== 429) throw err;
      }
      return signupPolicy.verificationResponse(user, sent);
    }
    if (user.status === 'pending_verification') await user.update({ status: 'active' });
  } else if (user.status === 'pending_verification') {
    // An account from when sign-up waited on the emailed link is let in now,
    // as a new one would be; the dashboard asks it to confirm its email.
    await user.update({ status: 'active' });
  }

  // Two-step sign-in (twoFactorService.js, TWO_FACTOR_ENABLED) and the new-device
  // code (newDeviceSignIn.js, NEW_DEVICE_CODE): from a browser that is not
  // remembered the answer is a challenge, and POST /auth/two-factor/verify
  // finishes the sign-in through completeLogin. Both off: as before.
  const newDevice = require('./newDeviceSignIn').needsCode(user, req);
  const challenge = await require('./twoFactorService').challengeIfNeeded(user, req, { locale, newDevice });
  if (challenge) return challenge;

  return completeLogin(user, req);
}

/** The last step of every password sign-in: stamp it, audit it, hand out the tokens. */
async function completeLogin(user, req) {
  await user.update({ lastLoginAt: new Date() });
  await recordAudit({ actorUserId: user.id, action: 'user.login', entityType: 'User', entityId: user.id, req });

  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

/**
 * What a Google sign-in answers an account that may not sign in: the same as
 * a password sign-in (login), ACCOUNT_SUSPENDED for a suspended account.
 * users.status is an ENUM of active, pending_verification and suspended;
 * anything else would be refused as not active, as authenticate and refresh
 * refuse it.
 */
function assertMaySignIn(user) {
  if (user.deletedAt) throw new AuthenticationError('This account was deleted', 'ACCOUNT_DELETED');
  if (user.status === 'active' || user.status === 'pending_verification') return;
  if (user.status === 'suspended') throw new AuthenticationError('This account has been suspended', 'ACCOUNT_SUSPENDED');
  throw new AuthenticationError('Account is not active', 'ACCOUNT_INACTIVE');
}

/** URL to send the browser to for Google's consent screen. */
function getGoogleAuthUrl(state) {
  return googleClient.getAuthUrl(state);
}

/**
 * Complete a Google OAuth login from the `code` Google redirected back with.
 * - known googleId  -> log that user in
 * - known email     -> link googleId to that account, then log in
 * - neither         -> create a new active, email-verified, passwordless user
 */
async function loginWithGoogle(code, req) {
  let profile;
  try {
    profile = await googleClient.fetchProfile(code);
  } catch (err) {
    logger.warn('Google sign-in: the code exchange failed', { message: err.message });
    throw new AuthenticationError('Google sign-in failed. Try again.', 'GOOGLE_LOGIN_FAILED');
  }
  if (!profile.googleId || !profile.email) {
    throw new AuthenticationError('Google did not return a usable profile', 'GOOGLE_PROFILE_INCOMPLETE');
  }
  // An address Google has not verified proves nothing about who owns it: it
  // never links to, or creates, an account under that email.
  if (!profile.emailVerified) {
    throw new AuthenticationError('Your Google account has no verified email', 'GOOGLE_EMAIL_UNVERIFIED');
  }

  let user = await db.User.findOne({ where: { googleId: profile.googleId } });
  let action = 'user.login.google';

  let linkMetadata = null;
  if (!user) {
    const byEmail = await db.User.findOne({ where: { email: profile.email } });
    if (byEmail) {
      // Only an active or a pending account is linked. Any other status
      // (suspended) is left exactly as it is — no Google link, no password
      // or session change — and refused as a password sign-in refuses it:
      // signing in with Google must not lift a suspension.
      assertMaySignIn(byEmail);
      // Google has already verified this email, so a still-`pending_verification`
      // password account gets activated here too — otherwise it stays stuck as
      // pending forever (Google login never goes through resend-verification).
      //
      // A password account that never confirmed its email or phone may not
      // be this person's: anyone can sign up with an address they don't own.
      // So its password goes and every session (each holds a refresh token)
      // is ended: from here on only the Google owner signs in. An access
      // token already issued runs until it expires. A confirmed account keeps
      // its password.
      const unconfirmed = !byEmail.emailVerifiedAt && !byEmail.phoneVerifiedAt;
      await db.sequelize.transaction(async (transaction) => {
        await byEmail.update(
          {
            googleId: profile.googleId,
            ...(byEmail.status === 'pending_verification' ? { status: 'active' } : {}),
            emailVerifiedAt: new Date(),
            ...(unconfirmed ? { passwordHash: null } : {}),
          },
          { transaction }
        );
        if (unconfirmed) {
          const now = new Date();
          const [revoked] = await db.Session.update(
            { revokedAt: now },
            { where: { userId: byEmail.id, revokedAt: null }, transaction }
          );
          // Whatever second step the unconfirmed account had set up goes with its password.
          const devicesForgotten = await db.TrustedDevice.destroy({ where: { userId: byEmail.id }, transaction });
          const [challengesClosed] = await db.LoginChallenge.update({ consumedAt: now }, { where: { userId: byEmail.id, consumedAt: null }, transaction });
          const [twoFactorReset] = await db.UserTwoFactor.update(
            { mode: 'off', totpSecretSealed: null, pendingSecretSealed: null, enabledAt: null, backupCodes: [], backupCodesCreatedAt: null },
            { where: { userId: byEmail.id, mode: { [Op.ne]: 'off' } }, transaction }
          );
          linkMetadata = { unconfirmedAccount: true, passwordRemoved: true, sessionsRevoked: revoked, devicesForgotten, challengesClosed, twoFactorReset: twoFactorReset > 0 };
        }
      });
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
        // While a plan is required at sign-up, it picks one after signing in.
        ...(await signupPolicy.googleAccountFields(profile.email)),
      });
      action = 'user.register.google';
    }
  }

  assertMaySignIn(user);

  // Two-step sign-in: Google stands in for the password only. The account's
  // own second step is still asked from a browser it does not remember; the
  // new-device email code is not, since Google has just proved the address.
  // A link or a new account is recorded now; the sign-in itself when the code
  // is verified.
  const challenge = await require('./twoFactorService').challengeIfNeeded(user, req);
  if (challenge) {
    if (action !== 'user.login.google') {
      await recordAudit({ actorUserId: user.id, action, entityType: 'User', entityId: user.id, metadata: linkMetadata, req });
    }
    return challenge;
  }

  await user.update({ lastLoginAt: new Date() });
  await recordAudit({ actorUserId: user.id, action, entityType: 'User', entityId: user.id, metadata: linkMetadata, req });

  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

/** The token of a session that has already ended: always throws. */
async function refreshTokenReused(session, req) {
  const rotated = Boolean(session.rotatedToSessionId);
  if (!rotated && env.session.reuseRotatedOnly) {
    throw new AuthenticationError('This session has ended. Sign in again.', 'SESSION_ENDED');
  }
  // Reuse of a rotated-away token: revoke every session for this user as a
  // precaution against a stolen refresh token being replayed.
  const now = new Date();
  const [sessionsRevoked] = await db.Session.update(
    { revokedAt: now },
    { where: { userId: session.userId, revokedAt: null } }
  );
  // Recorded when it ended something: two tabs refreshing at the same
  // moment, or a refresh whose answer was lost, look the same as a stolen
  // token. `tokenEndedSecondsAgo` tells them apart afterwards.
  if (sessionsRevoked > 0) {
    await recordAudit({
      actorUserId: session.userId,
      action: 'user.refresh_reuse_detected',
      entityType: 'User',
      entityId: session.userId,
      metadata: { sessionsRevoked, rotated, tokenEndedSecondsAgo: Math.round((now - session.revokedAt) / 1000) },
      req,
    });
  }
  throw new AuthenticationError('Refresh token has already been used — all sessions revoked', 'REFRESH_TOKEN_REUSE_DETECTED');
}

/**
 * Refresh-token rotation: the presented raw token must hash-match an active,
 * non-revoked, non-expired Session. On success, that session is revoked and
 * immediately replaced by a brand new one (rotatedToSessionId links them),
 * and a fresh raw refresh token is returned. Presenting an already-rotated
 * (revoked) token is treated as a possible theft signal and revokes the
 * entire chain, not just the one session.
 *
 * A revoked token is one of two things. Rotated away (its session points at
 * a successor): it was used twice, as a stolen one would be. Or its session
 * was ended on purpose (signed out, a password reset, the other devices after
 * a second-step change) and the device that still holds it is asking. Both
 * end every session of the account, unless REFRESH_REUSE_ROTATED_ONLY is on:
 * then the second is refused alone, so a device that was left signed in is
 * not signed out by another one waking up.
 */
async function refresh(rawRefreshToken, req) {
  const tokenHash = hashToken(rawRefreshToken);
  const session = await db.Session.findOne({ where: { refreshTokenHash: tokenHash } });

  if (!session) {
    throw new AuthenticationError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }

  if (session.revokedAt) return refreshTokenReused(session, req);

  if (session.expiresAt < new Date()) {
    throw new AuthenticationError('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
  }

  const user = await db.User.findByPk(session.userId);
  if (!user || user.status !== 'active') {
    throw new AuthenticationError('Account is not active', 'ACCOUNT_INACTIVE');
  }

  // One token makes one new session. The old session is ended by a write that
  // lands only while it is still live, and the new one is written with it or
  // not at all: of two requests presenting the same token together, the
  // second waits for the first, finds the session already ended and is a
  // token presented a second time. Its handling writes and then throws, so it
  // runs after this transaction, not inside it.
  const rotation = await db.sequelize.transaction(async (transaction) => {
    const successorId = crypto.randomUUID();
    const [ended] = await db.Session.update(
      { revokedAt: new Date(), rotatedToSessionId: successorId },
      { where: { id: session.id, revokedAt: null }, transaction }
    );
    if (ended !== 1) return null;
    const created = await createSession(user, req, { id: successorId, transaction });
    // This browser's device notifications follow it to the new session (no-op while push is off).
    await pushSessions.followRotation(session.id, successorId, transaction);
    return created;
  });
  if (!rotation) {
    const ended = await db.Session.findByPk(session.id);
    if (!ended) throw new AuthenticationError('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    return refreshTokenReused(ended, req);
  }
  // The gate's answers were emptied when the row changed, before the commit.
  sessionGate.forgetAll();
  const { raw, session: newSession } = rotation;

  const accessToken = signAccessToken({ sub: user.id, sid: newSession.id });
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

/**
 * POST /auth/sessions/revoke-all — "sign out of all devices". Every session
 * of the account ends, the one asking included, and with them what would let
 * a device back in without the whole sign-in: the browsers remembered for
 * the second step are forgotten, and a sign-in that passed the password and
 * waits for its code is closed. The access tokens already out stop with their
 * sessions (core/security/sessionGate).
 */
async function revokeAllSessions(userId, req) {
  const now = new Date();
  await db.sequelize.transaction(async (transaction) => {
    const [sessionsRevoked] = await db.Session.update({ revokedAt: now }, { where: { userId, revokedAt: null }, transaction });
    const devicesForgotten = await db.TrustedDevice.destroy({ where: { userId }, transaction });
    const [challengesClosed] = await db.LoginChallenge.update({ consumedAt: now }, { where: { userId, consumedAt: null }, transaction });
    await recordAudit({
      actorUserId: userId,
      action: 'user.revoke_all_sessions',
      entityType: 'User',
      entityId: userId,
      metadata: { sessionsRevoked, devicesForgotten, challengesClosed },
      req,
      transaction,
    });
  });
  // The gate's answers were emptied when the rows changed, before the commit:
  // one asked for in between would stand for its ten seconds.
  sessionGate.forgetAll();
  return { success: true };
}

/**
 * Ends every session of the account except the one this request came on
 * (its access token's `sid`, followed through any refresh since). For a
 * change the person just made themselves on this device: it stays signed in,
 * every other device signs in again. Returns how many ended.
 */
async function endOtherSessions(userId, req) {
  const sid = req && req.authTokenPayload ? req.authTokenPayload.sid : null;
  const keep = await sessionGate.currentSessionId(sid);
  const where = { userId, revokedAt: null };
  if (keep) where.id = { [Op.ne]: keep };
  const [ended] = await db.Session.update({ revokedAt: new Date() }, { where });
  return ended;
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

/**
 * The password-reset link needs FRONTEND_URL in production (the localhost
 * default would email a link nobody can open). Without it every request is
 * refused alike, so the refusal says nothing about any address.
 */
function assertResetLinksConfigured() {
  if (env.isProduction && !env.frontendUrlConfigured) {
    logger.error('Password reset refused: FRONTEND_URL is not set, so the emailed link would not open');
    throw new AppError('PASSWORD_RESET_UNAVAILABLE', 'Password reset is not available right now. Try again later.', 503);
  }
}

// Reset emails still being prepared or sent (see requestPasswordReset).
const pendingResets = new Set();

/** Resolves once every reset email started so far has been handled. For tests and shutdown. */
function settlePasswordResets() {
  return Promise.all([...pendingResets]);
}

/**
 * POST /auth/password-reset/request. Answers at once and the same way for
 * every address — registered or not, with or without a password (a Google
 * account gets a link that sets one), within its limit or past it — so
 * neither the answer nor its timing tells which. The lookup, the limit and
 * the email happen after the answer.
 */
function requestPasswordReset(email, { locale } = {}) {
  assertResetLinksConfigured();
  const job = sendPasswordResetLink(email, { locale })
    .catch((err) => logger.error('Could not send a password reset link', { message: err.message }))
    .finally(() => pendingResets.delete(job));
  pendingResets.add(job);
  return { success: true };
}

/**
 * Emails a reset link to the account with this email, if there is one and it
 * is within its limit: a random 32-byte token, stored only as its SHA-256,
 * valid PASSWORD_RESET_TTL_MS, used once. A new link replaces the account's
 * earlier ones.
 */
async function sendPasswordResetLink(email, { locale } = {}) {
  const user = await db.User.findOne({ where: { email } });
  if (!user) return;

  const now = Date.now();
  const since = (ms) => ({ userId: user.id, type: 'password_reset', createdAt: { [Op.gt]: new Date(now - ms) } });
  const [lastHour, lastDay] = await Promise.all([
    db.VerificationToken.count({ where: since(60 * 60 * 1000) }),
    db.VerificationToken.count({ where: since(24 * 60 * 60 * 1000) }),
  ]);
  if (lastHour >= PASSWORD_RESET_LIMITS.perHour || lastDay >= PASSWORD_RESET_LIMITS.perDay) {
    logger.info('Password reset link not sent: the account reached its limit', { userId: user.id });
    return;
  }

  const rawToken = generateOpaqueToken();
  await db.sequelize.transaction(async (transaction) => {
    await db.VerificationToken.update(
      { usedAt: new Date(now) },
      { where: { userId: user.id, type: 'password_reset', usedAt: null }, transaction }
    );
    await db.VerificationToken.create(
      {
        userId: user.id,
        type: 'password_reset',
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(now + PASSWORD_RESET_TTL_MS),
      },
      { transaction }
    );
  });
  await notify.email({
    recipient: user.email,
    template: 'password_reset',
    data: { token: rawToken, fullName: user.fullName, minutes: PASSWORD_RESET_TTL_MS / 60000, locale: locale === 'en' ? 'en' : 'ar' },
  });
}

function invalidResetToken() {
  return new AppError('INVALID_RESET_TOKEN', 'Password reset token is invalid or expired', 400);
}

/**
 * POST /auth/password-reset/confirm. One transaction, the token row locked,
 * so a link works once even when it is sent twice at the same moment. The
 * password changes, every session (each holds a refresh token) ends, and the
 * account's other open reset links stop working. The link reached the
 * address's owner, so an email not confirmed yet counts as confirmed (and a
 * pending account becomes active); the audit row says so.
 */
async function resetPassword(rawToken, newPassword, req) {
  const tokenHash = hashToken(rawToken);
  const passwordHash = await hashPassword(newPassword);
  return db.sequelize.transaction(async (transaction) => {
    const record = await db.VerificationToken.findOne({
      where: { tokenHash, type: 'password_reset' },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) throw invalidResetToken();
    const user = await db.User.findByPk(record.userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw invalidResetToken();

    const now = new Date();
    const confirmsEmail = !user.emailVerifiedAt;
    await user.update(
      {
        passwordHash,
        ...(confirmsEmail ? { emailVerifiedAt: now } : {}),
        ...(user.status === 'pending_verification' ? { status: 'active' } : {}),
      },
      { transaction }
    );
    await db.VerificationToken.update(
      { usedAt: now },
      { where: { userId: user.id, type: 'password_reset', usedAt: null }, transaction }
    );
    // A password reset is a strong signal the account may have been
    // compromised — revoke every existing session so old refresh tokens
    // (possibly in an attacker's hands) stop working immediately.
    const [sessionsRevoked] = await db.Session.update(
      { revokedAt: now },
      { where: { userId: user.id, revokedAt: null }, transaction }
    );
    // Two-step sign-in stays on; every browser asks for it again (twoFactorRecovery.js).
    await db.TrustedDevice.destroy({ where: { userId: user.id }, transaction });
    // A sign-in that passed the old password and waits for its code ends here, and the
    // account's wrong second-step codes stop counting, once a day.
    await require('./twoFactorService').forgiveWrongCodes(user.id, transaction);
    await recordAudit({
      actorUserId: user.id,
      action: 'user.password_reset',
      entityType: 'User',
      entityId: user.id,
      metadata: { emailConfirmed: confirmsEmail, sessionsRevoked },
      req,
      transaction,
    });
    return { success: true };
  });
}

// --- Sign-up codes (REQUIRE_SIGNUP_VERIFICATION) -------------------------

function assertUnconfirmed(user) {
  if (user.status === 'active' && signupPolicy.isVerified(user)) {
    throw new ConflictError('This account is already confirmed. Sign in.', 'ALREADY_VERIFIED');
  }
}

/** POST /auth/verify/send — a new code by 'email' or 'sms' (the account's own phone). */
async function sendVerificationCode(user, { channel = 'email', locale }, req) {
  assertUnconfirmed(user);
  const sent = await verificationCodes.sendCode(user, channel, { ip: req ? clientIp(req) : null, locale, req });
  return { sent: true, ...sent };
}

/** The address a right code went to is confirmed, and the account active. */
async function markConfirmed(user, channel, { signIn = false } = {}, req) {
  const now = new Date();
  await user.update({
    status: 'active',
    ...(signIn ? { lastLoginAt: now } : {}),
    ...(channel === 'sms' ? { phoneVerifiedAt: now, phone: normalizePhone(user.phone) || user.phone } : { emailVerifiedAt: now }),
  });
  await recordAudit({
    actorUserId: user.id,
    action: 'auth.verify.confirm',
    entityType: 'User',
    entityId: user.id,
    metadata: { channel },
    req,
  });
}

/**
 * POST /auth/verify/confirm — the right code confirms the address it went to,
 * activates the account and signs it in at once.
 */
async function confirmVerificationCode(user, code, req) {
  assertUnconfirmed(user);
  const { channel } = await verificationCodes.confirmCode(user, code, { req });
  await markConfirmed(user, channel, { signIn: true }, req);
  const tokens = await issueTokenPair(user, req);
  return { user: user.toSafeJSON(), ...tokens };
}

// --- Confirming a signed-in account's email --------------------------------
// An account signed in before confirming its email (sign-up codes off, or an
// older account) confirms it with the same codes, limits included, from the
// dashboard's banner. Confirmed by email or by phone counts, as everywhere
// (signupPolicy.isVerified).

function alreadyConfirmed() {
  return new ConflictError('This account is already confirmed.', 'ALREADY_VERIFIED');
}

/** POST /auth/me/email/send-code */
async function sendAccountCode(user, { locale } = {}, req) {
  if (signupPolicy.isVerified(user)) throw alreadyConfirmed();
  if (!verificationCodes.emailReady()) {
    throw new AppError('EMAIL_UNAVAILABLE', 'Codes cannot be sent by email right now. Try again later.', 503);
  }
  const sent = await verificationCodes.sendCode(user, 'email', { ip: req ? clientIp(req) : null, locale, req });
  return { sent: true, ...sent };
}

/** POST /auth/me/email/confirm — no new tokens: the session goes on as it is. */
async function confirmAccountCode(user, code, req) {
  if (signupPolicy.isVerified(user)) throw alreadyConfirmed();
  const { channel } = await verificationCodes.confirmCode(user, code, { req });
  await markConfirmed(user, channel, {}, req);
  return { user: user.toSafeJSON(), confirmed: true };
}

// --- Phone verification (during/after registration) ----------------------

// How many codes one account may ask for is counted per account on the route
// (accountLimiter.phoneVerificationLimiter); the row keeps the asking client.
async function requestPhoneVerification(userId, phone, req) {
  const ip = req ? clientIp(req) : null;
  const requestIp = ip ? ipKeyGenerator(ip) : null;
  // SMS_ALLOWED_COUNTRIES: a number the SMS may not go to is told so before a code is made.
  const normalized = normalizePhone(phone);
  if (normalized && !notify.smsCountryAllowed(normalized)) {
    throw new AppError('SMS_COUNTRY_NOT_ALLOWED', 'Codes cannot be sent by SMS to numbers in this country', 422, [
      { field: 'phone', message: 'Codes cannot be sent by SMS to numbers in this country' },
    ]);
  }
  // VERIFY_PHONE_PER_IP_PER_DAY: every account asking from this client counts, so new free
  // accounts no longer bring a new allowance each.
  const perDay = env.verifyPhone.ipPerDay;
  if (perDay && requestIp) {
    const sent = await db.OtpCode.count({
      where: { requestIp, purpose: 'phone_verification', createdAt: { [Op.gt]: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    if (sent >= perDay) throw new AppError('OTP_RATE_LIMITED', 'Too many codes requested from this network today — try again tomorrow', 429);
  }
  await otpService.generateAndSendOtp(phone, 'phone_verification', { requestIp });
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
  // Before the lookup, so this answer too is the same for every phone.
  if (!verificationCodes.smsReady()) {
    throw new AppError('SMS_UNAVAILABLE', 'Codes cannot be sent by SMS right now. Try again later.', 503);
  }
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
  await db.TrustedDevice.destroy({ where: { userId: user.id } });
  // Sign-ins waiting for their second step end; wrong codes stop counting, once a day.
  await require('./twoFactorService').forgiveWrongCodes(user.id);
  await recordAudit({ actorUserId: user.id, action: 'user.password_reset_sms', entityType: 'User', entityId: user.id });
  return { success: true };
}

module.exports = {
  // A fresh access token and session for `user` (auth/accountService, after an email change).
  issueTokenPair,
  register,
  sendVerificationCode,
  confirmVerificationCode,
  sendAccountCode,
  confirmAccountCode,
  verifyEmail,
  resendVerificationEmail,
  login,
  completeLogin,
  getGoogleAuthUrl,
  loginWithGoogle,
  refresh,
  logout,
  revokeAllSessions,
  endOtherSessions,
  listSessions,
  requestPasswordReset,
  settlePasswordResets,
  resetPassword,
  requestPhoneVerification,
  confirmPhoneVerification,
  requestPasswordResetSms,
  resetPasswordSms,
};
