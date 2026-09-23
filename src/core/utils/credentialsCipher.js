'use strict';

const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('./logger');

/**
 * Encryption at rest for third-party credentials a merchant hands us (courier
 * API keys today). AES-256-GCM: authenticated, so a flipped byte in the
 * database fails loudly on decrypt instead of producing a wrong key.
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
 * The key is CARRIER_CREDENTIALS_KEY: 32 bytes, base64. Unset or malformed
 * means "not configured" — callers answer 503 CARRIERS_NOT_CONFIGURED; the app
 * still boots.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let warnedInvalidKey = false;

function parseKey(raw) {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    if (!warnedInvalidKey) {
      warnedInvalidKey = true;
      logger.error('CARRIER_CREDENTIALS_KEY is set but is not 32 bytes of base64 — carrier features are disabled');
    }
    return null;
  }
  return key;
}

/** The configured key, or null. Read on every call so tests can swap it. */
function getKey() {
  return parseKey(env.carriers.credentialsKey);
}

function isConfigured() {
  return getKey() !== null;
}

function encrypt(value, aad, key = getKey()) {
  if (!key) throw new Error('credentials key is not configured');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/** Throws on a wrong key, a wrong `aad`, or any tampering. */
function decrypt(stored, aad, key = getKey()) {
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

module.exports = { encrypt, decrypt, isConfigured, getKey, parseKey };
