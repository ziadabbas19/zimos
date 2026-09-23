'use strict';

// The encryption used for merchants' courier credentials at rest.

const crypto = require('crypto');
const env = require('../../src/config/env');
const cipher = require('../../src/core/utils/credentialsCipher');

const KEY = crypto.randomBytes(32);
const AAD = 'workspace-1:bosta';
const SECRET = { apiKey: 'super-secret-bosta-key' };

/** Flips one character of one colon-separated part of the stored value. */
function tamper(stored, part) {
  const parts = stored.split(':');
  const chars = parts[part].split('');
  chars[2] = chars[2] === 'A' ? 'B' : 'A';
  parts[part] = chars.join('');
  return parts.join(':');
}

describe('credentialsCipher', () => {
  it('round-trips a credentials object', () => {
    const stored = cipher.encrypt(SECRET, AAD, KEY);
    expect(cipher.decrypt(stored, AAD, KEY)).toEqual(SECRET);
  });

  it('stores v1:iv:tag:ciphertext and never the plaintext', () => {
    const stored = cipher.encrypt(SECRET, AAD, KEY);
    expect(stored).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain(SECRET.apiKey);
    expect(Buffer.from(stored.split(':')[1], 'base64url')).toHaveLength(12);
    expect(Buffer.from(stored.split(':')[2], 'base64url')).toHaveLength(16);
  });

  it('uses a fresh IV every time', () => {
    const a = cipher.encrypt(SECRET, AAD, KEY);
    const b = cipher.encrypt(SECRET, AAD, KEY);
    expect(a).not.toEqual(b);
    expect(a.split(':')[1]).not.toEqual(b.split(':')[1]);
  });

  it.each([
    ['iv', 1],
    ['auth tag', 2],
    ['ciphertext', 3],
  ])('detects a tampered %s', (label, part) => {
    const stored = cipher.encrypt(SECRET, AAD, KEY);
    expect(() => cipher.decrypt(tamper(stored, part), AAD, KEY)).toThrow();
  });

  it('refuses a different context (row swapped to another workspace)', () => {
    const stored = cipher.encrypt(SECRET, AAD, KEY);
    expect(() => cipher.decrypt(stored, 'workspace-2:bosta', KEY)).toThrow();
  });

  it('refuses the wrong key', () => {
    const stored = cipher.encrypt(SECRET, AAD, KEY);
    expect(() => cipher.decrypt(stored, AAD, crypto.randomBytes(32))).toThrow();
  });

  it('refuses malformed values', () => {
    expect(() => cipher.decrypt('not-encrypted', AAD, KEY)).toThrow();
    expect(() => cipher.decrypt('v2:a:b:c', AAD, KEY)).toThrow();
  });

  describe('configuration', () => {
    const original = env.carriers.credentialsKey;
    afterEach(() => {
      env.carriers.credentialsKey = original;
    });

    it('is unconfigured without a key, and encrypt refuses', () => {
      env.carriers.credentialsKey = '';
      expect(cipher.isConfigured()).toBe(false);
      expect(() => cipher.encrypt(SECRET, AAD)).toThrow(/not configured/);
    });

    it('treats a key that is not 32 bytes as unconfigured instead of crashing', () => {
      env.carriers.credentialsKey = crypto.randomBytes(16).toString('base64');
      expect(cipher.isConfigured()).toBe(false);
    });

    it('uses CARRIER_CREDENTIALS_KEY when it is 32 bytes of base64', () => {
      env.carriers.credentialsKey = KEY.toString('base64');
      expect(cipher.isConfigured()).toBe(true);
      expect(cipher.decrypt(cipher.encrypt(SECRET, AAD), AAD, KEY)).toEqual(SECRET);
    });
  });
});
