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

async function generateAndSendOtp(rawPhone, purpose) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);

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
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  await notify.sms({ recipient: phone, template: `otp_${purpose}`, data: { code, purpose } });

  return { sent: true, phone };
}

async function verifyOtp(rawPhone, purpose, code) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);

  const otp = await db.OtpCode.findOne({
    where: { phone, purpose, consumedAt: null },
    order: [['createdAt', 'DESC']],
  });
  if (!otp) throw new AppError('INVALID_CODE', 'That code is not valid', 422);

  if (otp.attempts >= MAX_ATTEMPTS) {
    throw new AppError('TOO_MANY_ATTEMPTS', 'Too many incorrect attempts — request a new code', 429);
  }
  if (otp.expiresAt.getTime() < Date.now()) {
    throw new AppError('EXPIRED', 'That code has expired — request a new one', 422);
  }

  if (otp.codeHash !== hashCode(code)) {
    await otp.increment('attempts');
    throw new AppError('INVALID_CODE', 'That code is not valid', 422);
  }

  await otp.update({ consumedAt: new Date() });
  return { verified: true, phone };
}

module.exports = { generateAndSendOtp, verifyOtp, CODE_TTL_MS, MAX_ATTEMPTS, MAX_SENDS_PER_WINDOW };
