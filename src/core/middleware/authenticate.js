'use strict';

const asyncHandler = require('express-async-handler');
const { verifyAccessToken } = require('../security/tokens');
const { AuthenticationError } = require('../errors/AppError');
const db = require('../../db/models');

/**
 * Populates req.user (the authenticated User instance) from a Bearer access
 * token. Does NOT resolve workspace/tenant context or permissions — that's
 * tenantContext.js, which always runs after this. Keeping the two concerns
 * separate means an authenticated-but-not-a-member-of-this-workspace request
 * fails at the tenant boundary, not by silently defaulting to some workspace.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw new AuthenticationError('Missing or malformed Authorization header');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    throw new AuthenticationError('Invalid or expired access token', 'INVALID_TOKEN');
  }

  const user = await db.User.findByPk(payload.sub);
  if (!user || user.status !== 'active') {
    throw new AuthenticationError('Account is not active', 'ACCOUNT_INACTIVE');
  }

  req.user = user;
  req.authTokenPayload = payload;
  next();
});

/**
 * Same as authenticate, but also lets a `pending_verification` user through
 * (only a `suspended` account is rejected). Used by the phone-verification
 * endpoints, which a user needs to reach right after registering — before
 * they've confirmed their email and become `active`.
 */
const authenticateAllowPending = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new AuthenticationError('Missing or malformed Authorization header');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    throw new AuthenticationError('Invalid or expired access token', 'INVALID_TOKEN');
  }

  const user = await db.User.findByPk(payload.sub);
  if (!user || user.status === 'suspended') {
    throw new AuthenticationError('Account is not active', 'ACCOUNT_INACTIVE');
  }

  req.user = user;
  req.authTokenPayload = payload;
  next();
});

/**
 * Same as authenticate, but does not throw if no/invalid token is present —
 * used by public storefront endpoints where a logged-in customer gets extra
 * context but a guest is still allowed through.
 */
const optionalAuthenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next();

  try {
    const payload = verifyAccessToken(token);
    const user = await db.User.findByPk(payload.sub);
    if (user && user.status === 'active') {
      req.user = user;
      req.authTokenPayload = payload;
    }
  } catch (err) {
    // Invalid token on an optional-auth route is treated as "no auth", not an error.
  }
  next();
});

module.exports = { authenticate, authenticateAllowPending, optionalAuthenticate };
