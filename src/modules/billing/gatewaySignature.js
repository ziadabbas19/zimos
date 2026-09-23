'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * Billing webhook authentication. The webhook has no session and no API key —
 * the signature IS the identity, and the events it carries flip a workspace's
 * subscription status, so an unverified request must never be processed.
 *
 * The gateway sends `X-Zimos-Signature: <hex>`, the HMAC-SHA256 of the raw
 * request body keyed with BILLING_WEBHOOK_SECRET. The RAW bytes matter: a
 * re-serialised req.body would differ from what was signed by key order or
 * whitespace alone, so app.js stashes them on req.rawBody.
 *
 * With no secret configured every webhook is refused. That is the safe
 * failure: an unconfigured deploy drops legitimate events (visible, and
 * retried by the gateway) instead of accepting forged ones.
 *
 * When a real gateway is chosen, adapt the header name / digest encoding here
 * and remap EVENT_STATUS_MAP in billingService.js to its event names.
 * Nothing else in the flow changes.
 */

const SIGNATURE_HEADER = 'x-zimos-signature';

/**
 * @param {Buffer|string} rawBody  the exact bytes received (req.rawBody)
 * @param {object} headers         req.headers (lower-cased by Node)
 * @returns {boolean}
 */
function verifyGatewaySignature(rawBody, headers) {
  const secret = env.billing.webhookSecret;
  if (!secret) {
    logger.error(
      'BILLING_WEBHOOK_SECRET is not set — rejecting every billing webhook. ' +
        'Set it to the shared secret configured on the payment gateway.'
    );
    return false;
  }

  const provided = headers ? headers[SIGNATURE_HEADER] : undefined;
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === 'string' ? rawBody : '', 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws when the lengths differ, so the length is checked
  // first — a signature of the wrong length is wrong regardless.
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/** The signature a body should carry — used by tests and by ops tooling. */
function signPayload(rawBody, secret = env.billing.webhookSecret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

module.exports = { verifyGatewaySignature, signPayload, SIGNATURE_HEADER };
