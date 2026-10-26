'use strict';

const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const { OrderRejectedError } = require('../fraud/fraudRules');
const captcha = require('./captcha');
const { recordAudit } = require('../audit/auditService');
const visitorGate = require('./visitorGate');

/**
 * Bot protection for the storefront checkout (SPEC §5.1).
 *
 *   1. Honeypot: a field no person sees or fills. Anything in it is a bot.
 *   2. Time token: the storefront asks for a token when the page opens and
 *      sends it back with the order. It is signed here, tied to the store,
 *      and an order that arrives less than MIN_SECONDS after it was issued
 *      (or with none, a forged one, or a stale one) is refused.
 *   3. Invisible challenge, when the store asks for it and a verifier is
 *      configured (./captcha).
 *
 * `settings.fraud_rules.bot_protection`: true / false. Unset, it follows
 * BOT_PROTECTION_DEFAULT (`on` / `off`, default off) in every environment, so
 * a storefront from before the guard keeps taking orders. `settings.fraud_rules.bot_captcha`: true adds the challenge.
 *
 * A failure is answered like any refused order — the generic ORDER_REJECTED —
 * and filed under Lost orders with reason `integrity_check`.
 */

const MIN_SECONDS = 3;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const HONEYPOT_FIELD = 'website';

const signingKey = crypto.createHash('sha256').update(`bot-protection:${env.jwt.accessSecret}`).digest();

function sign(payload) {
  return crypto.createHmac('sha256', signingKey).update(payload).digest('base64url');
}

function issueToken(workspaceId, now = Date.now()) {
  const payload = `${workspaceId}.${now}.${crypto.randomBytes(6).toString('base64url')}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/** The token's age in ms, or null when it is not one this server issued for this store. */
function tokenAge(token, workspaceId, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch (_) {
    return null;
  }
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }
  const [tokenWorkspace, issuedAt] = payload.split('.');
  if (tokenWorkspace !== workspaceId || !/^\d+$/.test(issuedAt)) return null;
  return now - Number(issuedAt);
}

/** What an unset bot_protection means. Off unless BOT_PROTECTION_DEFAULT=on: a storefront that does not send the guard yet must keep taking orders. */
const platformDefaultOn = () => process.env.BOT_PROTECTION_DEFAULT === 'on';

function settingsOf(workspace) {
  const rules = (workspace && workspace.settings && workspace.settings.fraud_rules) || {};
  return {
    enabled: typeof rules.bot_protection === 'boolean' ? rules.bot_protection : platformDefaultOn(),
    captcha: rules.bot_captcha === true,
  };
}

/** GET /store/:workspaceId/checkout/guard — what the storefront needs to pass the guard. */
const guardConfig = asyncHandler(async (req, res) => {
  const workspace = req.publicWorkspace;
  const settings = settingsOf(workspace);
  res.set('Cache-Control', 'no-store');
  if (!settings.enabled) return res.json({ enabled: false, token: null, minSeconds: 0, honeypotField: HONEYPOT_FIELD, captcha: null });
  return res.json({
    enabled: true,
    token: issueToken(workspace.id),
    minSeconds: MIN_SECONDS,
    honeypotField: HONEYPOT_FIELD,
    captcha: settings.captcha ? captcha.publicConfig() : null,
  });
});

function refuse(check) {
  const err = new OrderRejectedError({ customerId: null, flags: [`bot_${check}`], lostReason: 'integrity_check', toLost: true });
  return err;
}

/**
 * Throws the refusal when the checkout body fails a check. `body` carries
 * `website` (the honeypot), `botToken` and `captchaToken`.
 */
async function assertHuman(req, workspace, body) {
  const settings = settingsOf(workspace);
  if (!settings.enabled) return;
  if (typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '') throw refuse('honeypot');
  const age = tokenAge(body.botToken, workspace.id);
  if (age === null || age > MAX_AGE_MS) throw refuse('token');
  if (age < MIN_SECONDS * 1000) throw refuse('too_fast');
  if (settings.captcha && !(await captcha.verify(body.captchaToken, visitorGate.visitorIp(req)))) throw refuse('captcha');
}

/**
 * Checkout middleware, after validation: runs the checks, then takes the
 * guard's own fields off the body so the order never sees them. The seconds
 * the shopper spent on the page stay on the request for the risk score.
 */
const guardCheckout = asyncHandler(async (req, res, next) => {
  const body = req.body || {};
  // The device id rides with the guard's fields; it is kept on the request, not in the order body.
  req.deviceId = typeof body.deviceId === 'string' && body.deviceId.trim().length >= 8 ? body.deviceId.trim().slice(0, 128) : null;
  const age = tokenAge(body.botToken, req.publicWorkspace.id);
  try {
    await assertHuman(req, req.publicWorkspace, body);
  } catch (err) {
    req.checkoutRefusal = err.refusal;
    await recordAudit({
      workspaceId: req.publicWorkspace.id,
      action: 'order.blocked',
      entityType: 'Checkout',
      after: { flags: err.refusal ? err.refusal.flags : [] },
      req,
    }).catch(() => {});
    throw err;
  }
  req.secondsOnPage = age === null ? null : Math.round(age / 1000);
  delete body[HONEYPOT_FIELD];
  delete body.botToken;
  delete body.captchaToken;
  delete body.deviceId;
  next();
});

module.exports = { MIN_SECONDS, MAX_AGE_MS, HONEYPOT_FIELD, issueToken, tokenAge, platformDefaultOn, settingsOf, assertHuman, guardConfig, guardCheckout };
