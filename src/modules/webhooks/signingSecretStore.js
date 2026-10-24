'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const cipher = require('../../core/utils/credentialsCipher');
const { AppError } = require('../../core/errors/AppError');
const { secretHint } = require('./webhookSigning');

/**
 * Where an endpoint's signing secret is kept (migration 714). Unlike an API
 * key it cannot be hashed — every delivery is signed with it — so the next
 * best thing is to keep it sealed, as the carriers' and gateways' credentials
 * are:
 *
 *   WEBHOOK_SECRET_SEALING off  signing_secret in clear, as before
 *   WEBHOOK_SECRET_SEALING on   signing_secret_sealed = AES-256-GCM with
 *                               WEBHOOK_SECRETS_KEY, signing_secret null
 *
 * The sealed value is bound to its row (`webhook:<workspaceId>:<endpointId>`
 * as additional data): copied onto another endpoint, it does not open.
 *
 * Reading never asks the flag: a sealed row is opened and a clear one read as
 * it is. So rows sealed by scripts/seal-webhook-secrets.js, or while the flag
 * was on, keep being delivered after it is turned off; the next rotation
 * stores that endpoint's secret the way the flag says.
 *
 * Nothing here logs or returns a secret except readSecret, whose only callers
 * are the dispatcher (to sign) and the seal script.
 */

const sealingOn = () => env.webhooks.secretSealing === true;
const key = () => cipher.parseKey(env.webhooks.secretsKey, 'WEBHOOK_SECRETS_KEY');
// The key being rotated away from: read only (WEBHOOK_SECRETS_KEY_PREVIOUS).
const previousKey = () => cipher.parseKey(env.webhooks.secretsKeyPrevious, 'WEBHOOK_SECRETS_KEY_PREVIOUS');

/** 8 hex characters naming a key without revealing it: to tell two keys apart. */
const fingerprint = (k) => (k ? crypto.createHash('sha256').update(k).digest('hex').slice(0, 8) : null);
const aad = (workspaceId, endpointId) => `webhook:${workspaceId}:${endpointId}`;

/** The columns to write for a new secret of endpoint `endpointId`. */
function storedFields(workspaceId, endpointId, secret) {
  if (!sealingOn()) return { signingSecret: secret, signingSecretSealed: null };
  const k = key();
  if (!k) throw new AppError('WEBHOOK_SECRETS_NOT_CONFIGURED', 'Webhook signing secrets cannot be stored right now', 503);
  return { signingSecret: null, signingSecretSealed: cipher.encrypt(secret, aad(workspaceId, endpointId), k) };
}

/** The sealed form of `secret` for this endpoint, with the key given (the seal script). */
function seal(workspaceId, endpointId, secret, k = key()) {
  if (!k) throw new Error('WEBHOOK_SECRETS_KEY is not configured');
  return cipher.encrypt(secret, aad(workspaceId, endpointId), k);
}

/**
 * A sealed secret opened, and which key opened it: 'current' or 'previous'.
 * Throws when neither opens it (no key, another key, a value moved from
 * another row) — GCM refuses a wrong key, so trying two is safe.
 */
function openSealed(endpoint) {
  const keys = [['current', key()], ['previous', previousKey()]].filter(([, k]) => k);
  if (keys.length === 0) throw new Error('WEBHOOK_SECRETS_KEY is not configured');
  let last;
  for (const [which, k] of keys) {
    try {
      return { secret: cipher.decrypt(endpoint.signingSecretSealed, aad(endpoint.workspaceId, endpoint.id), k), which };
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/** The secret to sign with. Throws when it is sealed and opens with no key here. */
function readSecret(endpoint) {
  if (endpoint.signingSecretSealed) return openSealed(endpoint).secret;
  return endpoint.signingSecret;
}

/** "whsec_…abcd" for the dashboard, or null when the secret cannot be read here. */
function hintFor(endpoint) {
  try {
    const secret = readSecret(endpoint);
    return secret ? secretHint(secret) : null;
  } catch {
    return null;
  }
}

module.exports = { storedFields, seal, readSecret, openSealed, hintFor, sealingOn, fingerprint, key, previousKey };
