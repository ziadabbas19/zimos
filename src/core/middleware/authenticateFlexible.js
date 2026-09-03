'use strict';

const asyncHandler = require('express-async-handler');
const { verifyAccessToken } = require('../security/tokens');
const { AuthenticationError } = require('../errors/AppError');
const db = require('../../db/models');

/**
 * Like `authenticate`, but also accepts the access token via `?token=` (GET)
 * or a `token` form field (POST), so the merchant HTML forms work in a plain
 * browser with no Authorization header.
 */
const authenticateFlexible = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, headerToken] = header.split(' ');
  const token =
    scheme === 'Bearer' && headerToken
      ? headerToken
      : req.query.token || (req.body && req.body.token) || null;

  if (!token) throw new AuthenticationError('Missing access token');

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

module.exports = { authenticateFlexible };
