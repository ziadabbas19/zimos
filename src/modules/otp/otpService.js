'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const notify = require('../notifications/notify');

// Generic one-time-code over SMS: generateAndSendOtp(phone, purpose) then
// verifyOtp(phone, purpose, code). Code is 6 digits, stored only as a
// sha256 hash, valid 5 minutes, with the guess/send limits below.
const CODE_TTL_MS = 5 * 60 * 1000;
const SEND_WINDOW_MS = 10 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 3;
const MAX_ATTEMPTS = 5;

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const generateCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** Two hex digests compared in constant time (false when either is malformed). */
function sameDigest(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Required when called: verificationCodeService itself requires this module.
const smsReady = () => require('./verificationCodeService').smsReady();

/**
 * `channel`: 'sms' (default) or 'whatsapp' — the authentication template,
 * with SMS as the fallback when WhatsApp cannot deliver it (as checkoutOtp).
 * `requestIp`: the client the code was asked for by, kept on the row (as
 * checkoutOtp keeps it) so these sends show up in per-IP accounting.
 */
async function generateAndSendOtp(rawPhone, purpose, { channel = 'sms', requestIp = null } = {}) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  // A code that cannot leave is not "sent": the answer the account's other SMS codes give.
  if (channel === 'sms' && !smsReady()) {
    throw new AppError('SMS_UNAVAILABLE', 'Codes cannot be sent by SMS right now. Try again later.', 503);
  }

  const recentSends = await db.OtpCode.count({
    where: { phone, createdAt: { [Op.gt]: new Date(Date.now() - SEND_WINDOW_MS) } },
  });
  if (recentSends >= MAX_SENDS_PER_WINDOW) {
    throw new AppError('OTP_RATE_LIMITED', 'Too many codes requested — try again in a few minutes', 429);
  }

  const code = generateCode();
  await db.OtpCode.create({
    phone,
    purpose,
    codeHash: hashCode(code),
    requestIp: requestIp || null,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  const message = { recipient: phone, template: `otp_${purpose}`, data: { code, purpose } };
  let sentVia = 'sms';
  if (channel === 'whatsapp') {
    const result = await notify.whatsapp(message);
    if (result && result.status === 'failed') await notify.sms(message);
    else sentVia = 'whatsapp';
  } else {
    await notify.sms(message);
  }

  return { sent: true, phone, sentVia };
}

async function verifyOtp(rawPhone, purpose, code) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);

  // Each try is counted before the code is looked at, in one statement, so a
  // burst of parallel guesses shares the same MAX_ATTEMPTS tries.
  const [counted] = await db.sequelize.query(
    `UPDATE otp_codes SET attempts = attempts + 1, updated_at = now()
      WHERE id = (SELECT id FROM otp_codes WHERE phone = :phone AND purpose = :purpose AND consumed_at IS NULL
                  ORDER BY created_at DESC LIMIT 1)
        AND consumed_at IS NULL AND attempts < :max
      RETURNING id, code_hash AS "codeHash", expires_at AS "expiresAt"`,
    { replacements: { phone, purpose, max: MAX_ATTEMPTS }, type: db.Sequelize.QueryTypes.SELECT }
  );
  if (!counted) {
    const latest = await db.OtpCode.findOne({
      where: { phone, purpose, consumedAt: null },
      order: [['createdAt', 'DESC']],
      attributes: ['attempts'],
    });
    if (latest && latest.attempts >= MAX_ATTEMPTS) {
      throw new AppError('TOO_MANY_ATTEMPTS', 'Too many incorrect attempts — request a new code', 429);
    }
    throw new AppError('INVALID_CODE', 'That code is not valid', 422);
  }
  if (new Date(counted.expiresAt).getTime() < Date.now()) {
    throw new AppError('EXPIRED', 'That code has expired — request a new one', 422);
  }
  if (!sameDigest(counted.codeHash, hashCode(code))) {
    throw new AppError('INVALID_CODE', 'That code is not valid', 422);
  }

  // Single use, even when two right answers arrive together.
  const [consumed] = await db.OtpCode.update({ consumedAt: new Date() }, { where: { id: counted.id, consumedAt: null } });
  if (consumed !== 1) throw new AppError('INVALID_CODE', 'That code is not valid', 422);
  return { verified: true, phone };
}

module.exports = {
  generateAndSendOtp,
  verifyOtp,
  generateCode,
  sameDigest,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_SENDS_PER_WINDOW,
};
