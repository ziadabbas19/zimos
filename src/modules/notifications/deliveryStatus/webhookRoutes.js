'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const { AppError, AuthenticationError } = require('../../../core/errors/AppError');
const { requireDeliveryStatus, deliveryStatusOn } = require('./gate');
const events = require('./providerEvents');

/**
 * Delivery status webhooks — public, no session; the request is
 * verified before anything is read from it or stored:
 *
 *   POST /api/v1/webhooks/email/brevo  the secret BREVO_WEBHOOK_TOKEN, sent by
 *        Brevo as a Bearer token, as the basic-auth password, in an
 *        X-Webhook-Token header or as ?token= (constant-time compare)
 *   POST /api/v1/webhooks/sms/twilio   X-Twilio-Signature: HMAC-SHA1 with
 *        TWILIO_AUTH_TOKEN over the URL Twilio called + the sorted form fields
 *
 * 401 when the proof is wrong, 503 when the secret is not configured (the
 * provider retries later). A verified event that matches no message is
 * answered 200 so the provider does not retry it forever. Secrets never
 * reach a log line or a response.
 */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (given, secret) => Boolean(given) && crypto.timingSafeEqual(sha(given), sha(secret));

/** Every place Brevo may carry the secret. */
function brevoCandidates(req) {
  const out = [];
  const auth = String(req.get('authorization') || '');
  const [scheme, value = ''] = auth.split(' ');
  if (/^bearer$/i.test(scheme)) out.push(value.trim());
  if (/^basic$/i.test(scheme)) {
    const decoded = Buffer.from(value.trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon !== -1) out.push(decoded.slice(colon + 1));
  }
  if (req.get('x-webhook-token')) out.push(String(req.get('x-webhook-token')).trim());
  if (typeof req.query.token === 'string') out.push(req.query.token);
  return out.filter(Boolean);
}

function verifyBrevo(req) {
  const secret = env.notifications.brevo.webhookToken;
  if (!secret) throw new AppError('WEBHOOK_NOT_CONFIGURED', 'Email status webhook is not configured', 503);
  // Every candidate is compared, so the time taken does not say which one was close.
  const results = brevoCandidates(req).map((c) => sameSecret(c, secret));
  if (!results.includes(true)) throw new AuthenticationError('Invalid webhook credentials', 'INVALID_WEBHOOK_SIGNATURE');
}

/** The URLs Twilio may have signed: the configured public one, and the one this request arrived on. */
function twilioUrls(req) {
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const urls = [];
  if (env.notifications.webhookBaseUrl) urls.push(`${env.notifications.webhookBaseUrl}/api/${env.apiVersion}/webhooks/sms/twilio${query}`);
  urls.push(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
  return [...new Set(urls)];
}

function verifyTwilio(req) {
  const { authToken } = env.notifications.twilio;
  if (!authToken) throw new AppError('WEBHOOK_NOT_CONFIGURED', 'SMS status webhook is not configured', 503);
  const signature = String(req.get('x-twilio-signature') || '');
  const params = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  // twilio.validateRequest: Twilio's own algorithm (with and without the port), constant-time (scmp).
  const twilio = require('twilio');
  const ok = signature && twilioUrls(req).some((url) => {
    try {
      return twilio.validateRequest(authToken, signature, url, params);
    } catch {
      return false;
    }
  });
  if (!ok) throw new AuthenticationError('Invalid webhook signature', 'INVALID_WEBHOOK_SIGNATURE');
}

const MAX_EVENTS = 1000;

const router = Router();

// Off (DELIVERY_STATUS_ENABLED unset): 404, as before the feature. The Brevo
// route also serves the campaign emails' reports (EMAIL_CAMPAIGNS_ENABLED,
// emailCampaigns/campaignEvents.js): with only campaigns on, it reads
// campaign events and leaves the store's other emails exactly as before.
const campaignsOn = () => Boolean(env.emailCampaigns.enabled);
const requireEmailReports = (req, res, next) => (deliveryStatusOn() || campaignsOn() ? next() : requireDeliveryStatus(req, res, next));

router.post(
  '/email/brevo',
  requireEmailReports,
  asyncHandler(async (req, res) => {
    verifyBrevo(req);
    const list = (Array.isArray(req.body) ? req.body : [req.body]).slice(0, MAX_EVENTS);
    const counts = {};
    for (const e of list) {
      let outcome = deliveryStatusOn() ? await events.brevoEvent(e) : 'unknown';
      // Not one of the store's other emails: perhaps a campaign email (opens and clicks are only these).
      if (campaignsOn() && (outcome === 'unknown' || outcome === 'ignored')) {
        outcome = (await require('../../emailCampaigns/campaignEvents').brevoEvent(e)) || outcome;
      }
      counts[outcome] = (counts[outcome] || 0) + 1;
    }
    logger.info(`[deliveryStatus] brevo webhook: ${JSON.stringify(counts)}`);
    res.json({ ok: true, received: list.length, ...counts });
  })
);

router.post(
  '/sms/twilio',
  requireDeliveryStatus,
  asyncHandler(async (req, res) => {
    verifyTwilio(req);
    const outcome = await events.twilioStatus(req.body || {});
    logger.info(`[deliveryStatus] twilio webhook: ${outcome}`);
    res.json({ ok: true, outcome });
  })
);

/** The statusCallback put on each Twilio SMS; null while off or until NOTIFICATIONS_WEBHOOK_BASE_URL is set. */
function twilioStatusCallbackUrl() {
  const base = env.notifications.deliveryStatus ? env.notifications.webhookBaseUrl : null;
  return base ? `${base}/api/${env.apiVersion}/webhooks/sms/twilio` : null;
}

module.exports = { router, twilioStatusCallbackUrl, brevoCandidates, twilioUrls };
