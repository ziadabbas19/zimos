'use strict';

// The encryption used for merchants' courier credentials at rest.

const crypto = require('crypto');
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

  describe('keys', () => {
    it('always needs the key passed in', () => {
      expect(() => cipher.encrypt(SECRET, AAD)).toThrow(/not configured/);
      expect(() => cipher.decrypt(cipher.encrypt(SECRET, AAD, KEY), AAD)).toThrow(/not configured/);
    });

    it('parseKey: unset is unconfigured', () => {
      expect(cipher.parseKey('', 'TEST_KEY')).toBeNull();
      expect(cipher.parseKey(undefined, 'TEST_KEY')).toBeNull();
    });

    it('parseKey: a key that is not 32 bytes is unconfigured instead of crashing', () => {
      expect(cipher.parseKey(crypto.randomBytes(16).toString('base64'), 'TEST_KEY')).toBeNull();
    });

    it('parseKey: 32 bytes of base64 is a usable key', () => {
      const key = cipher.parseKey(KEY.toString('base64'), 'TEST_KEY');
      expect(cipher.decrypt(cipher.encrypt(SECRET, AAD, key), AAD, KEY)).toEqual(SECRET);
    });

    it('a key for one feature never opens rows written with another', () => {
      const carrierKey = crypto.randomBytes(32);
      const gatewayKey = crypto.randomBytes(32);
      const stored = cipher.encrypt(SECRET, AAD, gatewayKey);
      expect(() => cipher.decrypt(stored, AAD, carrierKey)).toThrow();
    });
  });
});
