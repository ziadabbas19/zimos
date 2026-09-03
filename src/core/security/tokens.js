'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../../config/env');

function signAccessToken(payload) {
  return jwt.sign(payload, env.jwt.accessSecret, { expiresIn: env.jwt.accessExpiresIn });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

/**
 * Refresh tokens are opaque random strings, not JWTs. Only a SHA-256 hash of
 * the token is ever persisted (in Session.refreshTokenHash) so that a
 * database leak does not hand out usable refresh tokens. The raw token is
 * returned to the client exactly once, at issuance.
 */
function generateRefreshToken() {
  const raw = crypto.randomBytes(48).toString('hex');
  const hash = hashToken(raw);
  return { raw, hash };
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashToken,
  generateOpaqueToken,
};
