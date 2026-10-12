'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, AuthenticationError, ValidationError } = require('../../core/errors/AppError');
const secretBox = require('../../core/utils/secretBox');
const { verifyPassword } = require('../../core/security/password');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');
const { clientIp } = require('../../core/middleware/clientIp');

/**
 * Two-step sign-in, while TWO_FACTOR_ENABLED is on (env.twoFactor).
 *
 *   email  a 6-digit code by email when signing in from a browser that is
 *          not remembered
 *   totp   a code from an authenticator app (RFC 6238: SHA-1, 30 s, 6 digits)
 *   whatsapp  a 6-digit code to the verified phone on WhatsApp (SMS, then
 *          email, when it cannot be delivered: twoFactorWhatsapp.js)
 *
 * The password check stays where it is (authService.login). When the person
 * has a second step and the browser is not remembered, login answers
 * { twoFactorRequired, challengeToken, … } instead of tokens, and
 * POST /auth/two-factor/verify finishes the sign-in. A browser that passes
 * may be remembered for 60 days through an httpOnly cookie, of which only a
 * hash is stored.
 *
 * Signing in with Google asks for the account's own second step too (not the
 * new-device code: Google has just proved the address).
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DEVICE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE = env.isProduction ? 'zimos_dev' : `zimos_dev_${env.port}`;
const COOKIE_PATH = `/api/${env.apiVersion}/auth`;

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// ───────────────────────────── TOTP ─────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function base32Decode(text) {
  let bits = '';
  for (const ch of String(text).replace(/=+$/, '').toUpperCase()) {
    const value = B32.indexOf(ch);
    if (value >= 0) bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpAt(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

/** True for the current 30-second code or its neighbours (a phone's clock may be a little off). */
function totpMatches(secret, code, now = Date.now()) {
  const given = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  const counter = Math.floor(now / 30000);
  return [-1, 0, 1].some((drift) => {
    const expected = totpAt(secret, counter + drift);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  });
}

// ───────────────────────────── settings ─────────────────────────────

async function settingsRow(userId) {
  const [row] = await db.UserTwoFactor.findOrCreate({ where: { userId }, defaults: { userId, mode: 'off' } });
  return row;
}

async function status(user) {
  const row = await db.UserTwoFactor.findByPk(user.id);
  const devices = await db.TrustedDevice.count({ where: { userId: user.id, expiresAt: { [db.Sequelize.Op.gt]: new Date() } } });
  return {
    mode: row ? row.mode : 'off',
    enabledAt: row ? row.enabledAt : null,
    rememberedDevices: devices,
    hasPassword: Boolean(user.passwordHash),
    // Backup codes left (twoFactorRecovery.js).
    ...require('./twoFactorRecovery').backupStatus(row),
  };
}

/** Changing the second step asks for the password again (when the account has one). */
async function assertPassword(user, password) {
  if (!user.passwordHash) return;
  if (!password || !(await verifyPassword(password, user.passwordHash))) {
    // 422, not 401: the dashboard treats a 401 as a dead session and signs out.
    throw new ValidationError([{ field: 'password', message: 'The password is not correct' }]);
  }
}

/**
 * TWO_FACTOR_CHANGE_ENDS_SESSIONS: once the second step has been turned on or
 * off, the account's other sessions end and sign in again under the new
 * setting; the device that made the change stays signed in. Off (the
 * default): sessions are left alone.
 */
async function endOtherSessionsAfterChange(user, req) {
  if (!env.session.endOthersOnTwoFactorChange) return;
  const sessionsEnded = await require('./authService').endOtherSessions(user.id, req);
  if (sessionsEnded > 0) {
    await recordAudit({
      actorUserId: user.id,
      action: 'user.other_sessions_ended',
      entityType: 'User',
      entityId: user.id,
      metadata: { reason: 'two_factor_change', sessionsEnded },
      req,
    });
  }
}

async function enableEmail(user, { password }, req) {
  await assertPassword(user, password);
  const row = await settingsRow(user.id);
  await row.update({ mode: 'email', totpSecretSealed: null, pendingSecretSealed: null, enabledAt: new Date() });
  await recordAudit({ actorUserId: user.id, action: 'user.two_factor_enable', entityType: 'User', entityId: user.id, after: { mode: 'email' }, req });
  await endOtherSessionsAfterChange(user, req);
  return status(user);
}

async function enableWhatsapp(user, { password }, req) {
  await assertPassword(user, password);
  await require('./twoFactorWhatsapp').enable(user, await settingsRow(user.id), req);
  await endOtherSessionsAfterChange(user, req);
  return status(user);
}

/** Step 1 of the authenticator setup: a new secret, shown as a QR code. Nothing changes until it is confirmed. */
async function setupTotp(user, { password }) {
  await assertPassword(user, password);
  const secret = base32Encode(crypto.randomBytes(20));
  const row = await settingsRow(user.id);
  await row.update({ pendingSecretSealed: secretBox.seal(secret) });
  const label = encodeURIComponent(`Zimos:${user.email}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=Zimos&algorithm=SHA1&digits=6&period=30`;
  let qrDataUrl = null;
  try {
    // eslint-disable-next-line global-require
    const png = await require('bwip-js').toBuffer({ bcid: 'qrcode', text: otpauthUrl, scale: 4 });
    qrDataUrl = `data:image/png;base64,${png.toString('base64')}`;
  } catch (err) {
    // The secret can still be typed into the app by hand.
  }
  return { secret, otpauthUrl, qrDataUrl };
}

async function confirmTotp(user, { code }, req) {
  const row = await settingsRow(user.id);
  if (!row.pendingSecretSealed) throw new AppError('TWO_FACTOR_NOT_STARTED', 'Start the authenticator setup first', 409);
  const secret = secretBox.open(row.pendingSecretSealed);
  if (!totpMatches(secret, code)) throw new ValidationError([{ field: 'code', message: 'That code is not correct. Check the time on your phone and try the newest code.' }]);
  await row.update({ mode: 'totp', totpSecretSealed: row.pendingSecretSealed, pendingSecretSealed: null, enabledAt: new Date() });
  await recordAudit({ actorUserId: user.id, action: 'user.two_factor_enable', entityType: 'User', entityId: user.id, after: { mode: 'totp' }, req });
  await endOtherSessionsAfterChange(user, req);
  return status(user);
}

async function disable(user, { password }, req) {
  await assertPassword(user, password);
  const row = await settingsRow(user.id);
  await row.update({ mode: 'off', totpSecretSealed: null, pendingSecretSealed: null, enabledAt: null, backupCodes: [], backupCodesCreatedAt: null });
  await db.TrustedDevice.destroy({ where: { userId: user.id } });
  await recordAudit({ actorUserId: user.id, action: 'user.two_factor_disable', entityType: 'User', entityId: user.id, req });
  await endOtherSessionsAfterChange(user, req);
  return status(user);
}

// ───────────────────────────── sign-in ─────────────────────────────

const readDeviceCookie = (req) => (req && req.cookies ? req.cookies[DEVICE_COOKIE] || null : null);

async function isTrusted(userId, req) {
  const raw = readDeviceCookie(req);
  if (!raw) return false;
  const device = await db.TrustedDevice.findOne({ where: { userId, deviceHash: sha256(raw) } });
  if (!device || device.expiresAt < new Date()) return false;
  await device.update({ lastUsedAt: new Date() });
  return true;
}

function maskEmail(email) {
  const [name, domain] = String(email).split('@');
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(2, name.length - 2))}@${domain}`;
}

/**
 * Called by authService.login once the password is right. Null = sign in as
 * usual; otherwise the answer login must return instead of tokens.
 */
async function challengeIfNeeded(user, req, { locale = 'ar', newDevice = false } = {}) {
  // Off (TWO_FACTOR_ENABLED unset): no account's own second step is asked.
  const row = env.twoFactor.enabled ? await db.UserTwoFactor.findByPk(user.id) : null;
  // Without a second step of its own, a browser new to the account is asked
  // for an email code (newDeviceSignIn.js, NEW_DEVICE_CODE).
  const mode = row && row.mode !== 'off' ? row.mode : newDevice ? 'email' : 'off';
  if (mode === 'off') return null;
  if (await isTrusted(user.id, req)) return null;
  const flag = mode !== (row && row.mode) ? { newDevice: true } : {};

  const base = { userId: user.id, channel: mode, expiresAt: new Date(Date.now() + CODE_TTL_MS), ipAddress: req ? clientIp(req) : null };
  if (mode === 'totp') {
    const challenge = await db.LoginChallenge.create(base);
    return { twoFactorRequired: true, challengeToken: challenge.id, channel: 'totp' };
  }

  // Not more than five codes in ten minutes for one account.
  const recent = await db.LoginChallenge.count({ where: { userId: user.id, createdAt: { [db.Sequelize.Op.gt]: new Date(Date.now() - CODE_TTL_MS) } } });
  if (recent >= 5) {
    // No new code for now, but the step still opens: a backup code works in it (twoFactorRecovery.js).
    const challenge = await db.LoginChallenge.create(base);
    return { twoFactorRequired: true, challengeToken: challenge.id, channel: mode, codeNotSent: true, ...flag };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const challenge = await db.LoginChallenge.create({ ...base, codeHash: sha256(`${user.id}:${code}`) });
  const minutes = CODE_TTL_MS / 60000;
  const phone = mode === 'whatsapp' ? await require('./twoFactorWhatsapp').sendCode(user, code, { minutes, locale }) : null;
  if (phone) return { twoFactorRequired: true, challengeToken: challenge.id, ...phone };
  await notify.email({ recipient: user.email, template: 'login_code', data: { code, minutes, locale } });
  return { twoFactorRequired: true, challengeToken: challenge.id, channel: 'email', sentTo: maskEmail(user.email), ...flag };
}

const invalid = () => new AuthenticationError('That code is not correct or has expired', 'INVALID_TWO_FACTOR_CODE');

// Wrong second-step codes one account may get, over all its sign-ins:
// each sign-in has its own 5 tries, but someone holding the password can sign in
// again and again, so the account has its own budget too. An authenticator code
// has 3 right answers (clock drift) in a million.
const ACCOUNT_WRONG_LIMITS = [
  { windowMs: 15 * 60 * 1000, max: 10 },
  { windowMs: 24 * 60 * 60 * 1000, max: 30 },
];
const accountLocked = () => new AppError('TWO_FACTOR_LOCKED', 'Too many wrong codes for this account. Try again later, or reset your password.', 429);

/**
 * Counts one try on the challenge before the code is looked at, under a lock
 * on the account, so parallel requests share the challenge's 5 tries and the
 * account's budget (the read-then-increment let a burst through). Resolves
 * the challenge's user id and code hash.
 */
async function countTry(challengeToken, userId) {
  return db.sequelize.transaction(async (transaction) => {
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `two-factor:${userId}` }, transaction });
    // attempts holds wrong tries only: a right code takes its try back (below).
    const [wrong] = await db.sequelize.query(
      `SELECT COALESCE(SUM(attempts) FILTER (WHERE created_at > now() - make_interval(secs => :short)), 0)::int AS "short",
              COALESCE(SUM(attempts), 0)::int AS "long"
         FROM login_challenges
        WHERE user_id = :userId AND channel <> 'wa_login' AND created_at > now() - make_interval(secs => :long)`,
      {
        replacements: { userId, short: ACCOUNT_WRONG_LIMITS[0].windowMs / 1000, long: ACCOUNT_WRONG_LIMITS[1].windowMs / 1000 },
        type: db.Sequelize.QueryTypes.SELECT,
        transaction,
      }
    );
    if (wrong.short >= ACCOUNT_WRONG_LIMITS[0].max || wrong.long >= ACCOUNT_WRONG_LIMITS[1].max) throw accountLocked();
    const [counted] = await db.sequelize.query(
      `UPDATE login_challenges SET attempts = attempts + 1
        WHERE id = :id AND channel <> 'wa_login' AND consumed_at IS NULL AND expires_at > now() AND attempts < :max
        RETURNING user_id AS "userId", channel, code_hash AS "codeHash"`,
      { replacements: { id: challengeToken, max: MAX_ATTEMPTS }, type: db.Sequelize.QueryTypes.SELECT, transaction }
    );
    return counted || null;
  });
}

/**
 * Closes the account's waiting sign-ins and forgets its wrong codes: a
 * password reset proves the owner, and whoever had the old password is out
 * (authService.resetPassword, resetPasswordSms). The wrong codes are forgotten
 * at most once in 24 hours (users.two_factor_forgiven_at, migration 622), so
 * resetting again and again (a swapped SIM, a read inbox) does not restart the
 * budget: 60 wrong codes a day at most, however many resets.
 */
async function forgiveWrongCodes(userId, transaction) {
  const since = new Date(Date.now() - ACCOUNT_WRONG_LIMITS[1].windowMs);
  await db.LoginChallenge.update(
    { consumedAt: db.sequelize.fn('COALESCE', db.sequelize.col('consumed_at'), db.sequelize.fn('now')) },
    { where: { userId, consumedAt: null }, transaction }
  );
  // The row lock on the user makes two resets at once forgive only once.
  const [forgiven] = await db.sequelize.query(
    `UPDATE users SET two_factor_forgiven_at = now()
      WHERE id = :userId AND (two_factor_forgiven_at IS NULL OR two_factor_forgiven_at <= :since)
      RETURNING id`,
    { replacements: { userId, since }, type: db.Sequelize.QueryTypes.SELECT, transaction }
  );
  if (!forgiven) return;
  await db.LoginChallenge.update({ attempts: 0 }, { where: { userId, createdAt: { [db.Sequelize.Op.gt]: since } }, transaction });
}

/** The second step. Returns the user to sign in; sets the remember-me cookie when asked. */
async function verifyChallenge({ challengeToken, code, rememberDevice }, req, res) {
  const challenge = await db.LoginChallenge.findByPk(challengeToken, { attributes: ['id', 'userId', 'channel', 'attempts', 'consumedAt', 'expiresAt'] });
  if (!challenge || challenge.consumedAt || challenge.expiresAt < new Date()) throw invalid();
  // A WhatsApp sign-in code stands in for the password: never finished here, where backup codes work (whatsappLogin.js).
  if (challenge.channel === 'wa_login') throw invalid();

  const counted = await countTry(challenge.id, challenge.userId);
  if (!counted) {
    const now = await db.LoginChallenge.findByPk(challenge.id, { attributes: ['attempts', 'consumedAt', 'expiresAt'] });
    if (now && !now.consumedAt && now.expiresAt > new Date() && now.attempts >= MAX_ATTEMPTS) throw new AppError('TOO_MANY_ATTEMPTS', 'Too many wrong codes. Sign in again to get a new one.', 429);
    throw invalid();
  }

  const user = await db.User.findByPk(counted.userId);
  if (!user || user.status !== 'active') throw invalid();

  let ok = false;
  if (counted.channel === 'totp') {
    const row = await db.UserTwoFactor.findByPk(user.id);
    ok = Boolean(row && row.totpSecretSealed) && totpMatches(secretBox.open(row.totpSecretSealed), code);
  } else {
    const given = sha256(`${user.id}:${String(code || '').replace(/\s/g, '')}`);
    ok = Boolean(counted.codeHash) && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(counted.codeHash));
  }
  // A backup code works in place of any channel's code (twoFactorRecovery.js).
  if (!ok) ok = await require('./twoFactorRecovery').useBackupCode(user, code, req);
  if (!ok) throw invalid();
  // One sign-in per challenge, even when two right answers arrive together; the
  // right code's try is taken back, so attempts counts wrong codes only.
  const [consumed] = await db.LoginChallenge.update(
    { consumedAt: new Date(), attempts: db.sequelize.literal('GREATEST(attempts - 1, 0)') },
    { where: { id: challenge.id, consumedAt: null } }
  );
  if (consumed !== 1) throw invalid();

  if (rememberDevice && res) {
    const raw = crypto.randomBytes(32).toString('hex');
    await db.TrustedDevice.create({
      userId: user.id,
      deviceHash: sha256(raw),
      userAgent: req ? String(req.headers['user-agent'] || '').slice(0, 500) : null,
      expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
    });
    res.cookie(DEVICE_COOKIE, raw, { httpOnly: true, secure: env.isProduction, sameSite: 'lax', path: COOKIE_PATH, maxAge: DEVICE_TTL_MS });
  }
  return user;
}

async function forgetDevices(user, req) {
  const removed = await db.TrustedDevice.destroy({ where: { userId: user.id } });
  await recordAudit({ actorUserId: user.id, action: 'user.trusted_devices_forget', entityType: 'User', entityId: user.id, after: { removed }, req });
  return status(user);
}

module.exports = { status, enableEmail, enableWhatsapp, setupTotp, confirmTotp, disable, challengeIfNeeded, verifyChallenge, forgiveWrongCodes, forgetDevices, totpAt, totpMatches, base32Encode };
