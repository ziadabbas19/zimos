'use strict';

const crypto = require('crypto');
const logger = require('./logger');

/**
 * Encryption at rest for third-party credentials a merchant hands us (courier
 * API keys, payment gateway keys). AES-256-GCM: authenticated, so a flipped
 * byte in the database fails loudly on decrypt instead of producing a wrong
 * key.
 *
 * Stored format (one text column, all parts base64url, colon-separated):
 *
 *   v1:<iv>:<authTag>:<ciphertext>
 *
 *   v1          format version — room for a key rotation later
 *   iv          12 random bytes, fresh for every encryption
 *   authTag     the 16-byte GCM tag
 *   ciphertext  UTF-8 JSON of the credentials object
 *
 * `aad` (additional authenticated data) is not stored: the caller passes the
 * same context string on both sides — for carrier accounts
 * `<workspaceId>:<carrierCode>`. It binds a ciphertext to the row it was
 * written for, so copying one workspace's encrypted credentials onto another
 * workspace's row does not decrypt.
 *
 * The key is always passed in. Each feature owns its own key
 * (CARRIER_CREDENTIALS_KEY, GATEWAY_CREDENTIALS_KEY) and reads it with
 * parseKey, so a leak of one never opens the other's rows. Unset or malformed
 * means "not configured" — the feature answers 503; the app still boots.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const warnedInvalid = new Set();

/**
 * 32 bytes of base64 → a key Buffer; anything else → null. `name` is the env
 * variable, used only in the one-time warning about a malformed value.
 */
function parseKey(raw, name = 'credentials key') {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    if (!warnedInvalid.has(name)) {
      warnedInvalid.add(name);
      logger.error(`${name} is set but is not 32 bytes of base64 — the features it protects are disabled`);
    }
    return null;
  }
  return key;
}

function encrypt(value, aad, key) {
  if (!key) throw new Error('credentials key is not configured');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/** Throws on a wrong key, a wrong `aad`, or any tampering. */
function decrypt(stored, aad, key) {
  if (!key) throw new Error('credentials key is not configured');
  const parts = typeof stored === 'string' ? stored.split(':') : [];
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unrecognised credentials format');
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('unrecognised credentials format');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

module.exports = { encrypt, decrypt, parseKey };
