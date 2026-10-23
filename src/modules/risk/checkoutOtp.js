'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const asyncHandler = require('express-async-handler');
const { ipKeyGenerator } = require('express-rate-limit');
const Joi = require('joi');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const notify = require('../notifications/notify');
const otpService = require('../otp/otpService');
const blockedEntries = require('../fraud/blockedEntries');
const { visitorIp } = require('./visitorGate');

/**
 * Phone verification at checkout (SPEC §5.6).
 *
 * Settings, under `settings.fraud_rules.checkout_otp`:
 *   enabled      on / off
 *   channel      'whatsapp' | 'sms'
 *   apply_to     'all' | 'cod_only' | 'risky_only'
 *   code_length  4–6 (default 4)
 * A fraud rule whose action is `require_otp` asks for a code too, whether or
 * not `enabled` is on.
 *
 * The flow: the shopper submits the order → the checkout answers 428
 * OTP_REQUIRED and a code is sent → the storefront asks for the code →
 * POST /checkout/otp/verify answers a short-lived `otpToken` → the storefront
 * submits the same order again with it. No order exists, no stock is held and
 * no pixel fires until that second submission goes through.
 *
 * Codes ride on the existing otp_codes table and otpService.verifyOtp
 * (purpose `checkout`, hashed, 5 minutes, 5 attempts, 3 sends per 10
 * minutes). A phone in the blocklist with scope `otp` is told a code is on
 * its way and is sent nothing: a row with an unguessable hash stands in for
 * the code, so the send limits, Resend and verify answer it exactly as any
 * other phone.
 *
 * Every code (and stand-in) records the store it was sent for and the client
 * that asked for it (otp_codes.workspace_id / request_ip). Resend only reaches
 * a phone this store challenged in the last RESEND_WINDOW_MS. With
 * CHECKOUT_OTP_IP_PER_MINUTE / _PER_HOUR set (env.checkoutOtp), one client
 * (an IPv6 /56) may have that many codes sent across every store; past it the
 * checkout, the COD switch and Resend answer 429 OTP_RATE_LIMITED.
 */

const PURPOSE = 'checkout';
const RESEND_AFTER_SECONDS = 60;
const PROOF_TTL_MS = 30 * 60 * 1000;
// Resend only reaches a phone this store challenged at checkout this recently.
const RESEND_WINDOW_MS = 30 * 60 * 1000;
const CHANNELS = ['whatsapp', 'sms'];
const APPLY_TO = ['all', 'cod_only', 'risky_only'];

const signingKey = crypto.createHash('sha256').update(`checkout-otp:${env.jwt.accessSecret}`).digest();
const sign = (payload) => crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

const settingsSchema = Joi.object({
  enabled: Joi.boolean().optional(),
  channel: Joi.string().valid(...CHANNELS).optional(),
  apply_to: Joi.string().valid(...APPLY_TO).optional(),
  code_length: Joi.number().integer().min(4).max(6).optional(),
});

function settingsOf(workspace) {
  const rules = (workspace && workspace.settings && workspace.settings.fraud_rules) || {};
  const stored = rules.checkout_otp && typeof rules.checkout_otp === 'object' ? rules.checkout_otp : {};
  return {
    enabled: stored.enabled === true,
    channel: CHANNELS.includes(stored.channel) ? stored.channel : 'whatsapp',
    applyTo: APPLY_TO.includes(stored.apply_to) ? stored.apply_to : 'all',
    codeLength: [4, 5, 6].includes(stored.code_length) ? stored.code_length : 4,
  };
}

/** A token proving `phone` was verified for this store, valid 30 minutes. */
function issueProof(workspaceId, phoneNormalized, now = Date.now()) {
  const payload = `${workspaceId}.${phoneNormalized}.${now}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function proofValid(token, workspaceId, phoneNormalized, now = Date.now()) {
  if (typeof token !== 'string' || !phoneNormalized) return false;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return false;
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  const [ws, phone, issuedAt] = payload.split('.');
  return ws === workspaceId && phone === phoneNormalized && /^\d+$/.test(issuedAt) && now - Number(issuedAt) <= PROOF_TTL_MS;
}

function maskPhone(phoneNormalized) {
  return phoneNormalized.length > 4 ? `${'•'.repeat(phoneNormalized.length - 4)}${phoneNormalized.slice(-4)}` : phoneNormalized;
}

/** The per-IP key a code is counted under: the address, or its /56 for IPv6. */
function ipKeyOf(req) {
  const ip = visitorIp(req);
  return ip ? ipKeyGenerator(ip) : null;
}

/** 429 when this client has used its send budget (env.checkoutOtp; off while unset). */
async function assertIpBudget(requestIp) {
  const { ipPerMinute, ipPerHour } = env.checkoutOtp;
  if (!requestIp || (!ipPerMinute && !ipPerHour)) return;
  const since = (ms) => ({ requestIp, purpose: PURPOSE, createdAt: { [Op.gt]: new Date(Date.now() - ms) } });
  if (
    (ipPerMinute && (await db.OtpCode.count({ where: since(60 * 1000) })) >= ipPerMinute) ||
    (ipPerHour && (await db.OtpCode.count({ where: since(60 * 60 * 1000) })) >= ipPerHour)
  ) {
    throw new AppError('OTP_RATE_LIMITED', 'Too many codes requested — try again later', 429);
  }
}

/**
 * Sends a code unless the client has used its send budget (429 always), one
 * went out to the phone in the last minute, or the phone's send limit is
 * reached. `strict` (the Resend button) turns the last two quiet cases into
 * errors the shopper sees. A phone blocked from codes goes through the same
 * checks and gets a stand-in row instead of a code, so nothing tells it apart.
 */
async function sendCode(workspace, rawPhone, { strict = false, req = null } = {}) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  const settings = settingsOf(workspace);

  const requestIp = ipKeyOf(req);
  await assertIpBudget(requestIp);

  const latest = await db.OtpCode.findOne({ where: { phone, purpose: PURPOSE }, order: [['createdAt', 'DESC']] });
  if (latest && Date.now() - latest.createdAt.getTime() < RESEND_AFTER_SECONDS * 1000) {
    if (strict) throw new AppError('OTP_RESEND_TOO_SOON', 'Wait a minute before asking for another code', 429);
    return { sent: false, phone };
  }
  const recent = await db.OtpCode.count({ where: { phone, createdAt: { [Op.gt]: new Date(Date.now() - 10 * 60 * 1000) } } });
  if (recent >= otpService.MAX_SENDS_PER_WINDOW) {
    if (strict) throw new AppError('OTP_RATE_LIMITED', 'Too many codes requested — try again in a few minutes', 429);
    return { sent: false, phone };
  }

  const row = { phone, purpose: PURPOSE, workspaceId: workspace.id, requestIp, expiresAt: new Date(Date.now() + otpService.CODE_TTL_MS) };
  if (await blockedEntries.findMatch(workspace.id, 'otp', { phoneNormalized: phone })) {
    // No code exists for this row: the hash of 32 random bytes matches no 4–6 digit code.
    await db.OtpCode.create({ ...row, codeHash: hashCode(crypto.randomBytes(32).toString('hex')) });
    return { sent: false, phone };
  }
  const code = String(crypto.randomInt(0, 10 ** settings.codeLength)).padStart(settings.codeLength, '0');
  await db.OtpCode.create({ ...row, codeHash: hashCode(code) });
  // The SMS names the store, not the platform (notify.smsBody); a row loaded without the name reads it.
  const storeName =
    workspace.name !== undefined ? workspace.name : ((await db.Workspace.findByPk(workspace.id, { attributes: ['name'] })) || {}).name;
  const message = {
    recipient: phone,
    template: 'otp_checkout',
    data: { code, purpose: PURPOSE, minutes: 5, locale: String(workspace.defaultLocale || '').startsWith('ar') ? 'ar' : 'en', storeName: storeName || '' },
    workspaceId: workspace.id,
  };
  // WhatsApp goes through the authentication template; SMS is the fallback when it cannot be sent.
  const result = settings.channel === 'whatsapp' ? await notify.whatsapp(message) : await notify.sms(message);
  if (settings.channel === 'whatsapp' && result && result.status === 'failed') await notify.sms(message);
  return { sent: true, phone };
}

/** The 428 the checkout answers while the phone is unverified. Sends the code first. */
async function challengeError(workspaceOrId, rawPhone, { req = null } = {}) {
  const workspace =
    typeof workspaceOrId === 'string'
      ? await db.Workspace.findByPk(workspaceOrId, { attributes: ['id', 'settings', 'defaultLocale'] })
      : workspaceOrId;
  const { phone } = await sendCode(workspace, rawPhone, { req });
  const settings = settingsOf(workspace);
  const err = new AppError('OTP_REQUIRED', 'Enter the code we sent to your phone to place the order', 428, {
    channel: settings.channel,
    codeLength: settings.codeLength,
    resendAfterSeconds: RESEND_AFTER_SECONDS,
    phoneHint: maskPhone(phone),
  });
  // For Lost orders: the checkout waits as `awaiting_otp`, and stays lost as `otp_unverified`.
  Object.defineProperty(err, 'refusal', {
    value: { customerId: null, flags: ['otp_required'], platformBlock: null, lostReason: 'otp_unverified', toLost: true, awaitingOtp: true },
    enumerable: false,
  });
  return err;
}

/** Thrown inside createOrder's transaction; its catch turns it into the challenge. */
class NeedsOtp extends Error {}

/**
 * Checkout middleware, after the bot guard. Notes on the request whether the
 * phone is already verified, and challenges right away when the store asks
 * every order (or every COD order) for a code. `risky_only` is decided later,
 * inside createOrder, once the rules and the risk score have run.
 */
const guardCheckout = asyncHandler(async (req, res, next) => {
  const workspace = req.publicWorkspace;
  const body = req.body || {};
  const phone = normalizePhone(body.contact && body.contact.phone);
  req.otpVerified = proofValid(body.otpToken, workspace.id, phone);
  delete body.otpToken;

  const settings = settingsOf(workspace);
  req.otpIfRisky = settings.enabled && settings.applyTo === 'risky_only';
  const always = settings.enabled && (settings.applyTo === 'all' || (settings.applyTo === 'cod_only' && body.paymentMethod === 'cod'));
  if (always && !req.otpVerified && phone) {
    const err = await challengeError(workspace, body.contact.phone, { req });
    req.checkoutRefusal = err.refusal;
    throw err;
  }
  next();
});

/** Whether createOrder must stop for a code: a rule asked, or the store verifies risky orders and this is one. */
function needsOtp(req, { requireOtp, riskLevel, flags }) {
  if (!req || req.user || req.otpVerified) return false;
  if (requireOtp) return true;
  return Boolean(req.otpIfRisky && ((riskLevel && riskLevel !== 'low') || (flags && flags.length > 0)));
}

const phoneBody = Joi.object({ phone: Joi.string().trim().min(1).max(32).required() });
const verifyBody = phoneBody.keys({ code: Joi.string().trim().pattern(/^\d{4,6}$/).required() });

function parse(schema, body) {
  const { error, value } = schema.validate(body || {}, { abortEarly: false, stripUnknown: true });
  if (error) throw new AppError('VALIDATION_ERROR', 'Invalid body', 422, error.details.map((d) => ({ field: d.path.join('.'), message: d.message })));
  return value;
}

/** POST /store/:workspaceId/checkout/otp/verify → { otpToken } */
const verify = asyncHandler(async (req, res) => {
  const { phone, code } = parse(verifyBody, req.body);
  const result = await otpService.verifyOtp(phone, PURPOSE, code);
  res.json({ verified: true, otpToken: issueProof(req.publicWorkspace.id, result.phone) });
});

/**
 * POST /store/:workspaceId/checkout/otp/resend
 *
 * Only a second code: the first one goes out when this store's checkout
 * answers 428 OTP_REQUIRED (or the COD switch asks for one). A phone this
 * store has not challenged in the last 30 minutes gets 409
 * OTP_NOT_REQUESTED and nothing is sent, so the button cannot send codes to
 * any number through any store.
 */
const resend = asyncHandler(async (req, res) => {
  const { phone: rawPhone } = parse(phoneBody, req.body);
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  const challenged = await db.OtpCode.count({
    where: { phone, purpose: PURPOSE, workspaceId: req.publicWorkspace.id, createdAt: { [Op.gt]: new Date(Date.now() - RESEND_WINDOW_MS) } },
  });
  // A phone blocked from codes was challenged too (a stand-in row), so this never reads the blocklist.
  if (!challenged) {
    throw new AppError('OTP_NOT_REQUESTED', 'Place the order again to get a code', 409);
  }
  await sendCode(req.publicWorkspace, rawPhone, { strict: true, req });
  res.json({ sent: true, resendAfterSeconds: RESEND_AFTER_SECONDS });
});

module.exports = {
  PURPOSE,
  CHANNELS,
  APPLY_TO,
  settingsSchema,
  settingsOf,
  issueProof,
  proofValid,
  sendCode,
  challengeError,
  NeedsOtp,
  guardCheckout,
  needsOtp,
  verify,
  resend,
};
