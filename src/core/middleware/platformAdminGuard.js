'use strict';

const { AuthorizationError } = require('../errors/AppError');

/**
 * Gate for the platform-admin endpoints. Bypasses workspace RBAC entirely;
 * the only check is the global `users.platform_admin` flag. Runs after
 * `authenticate` / `authenticateFlexible`.
 */
function requirePlatformAdmin(req, res, next) {
  if (!req.user || req.user.platformAdmin !== true) {
    return next(new AuthorizationError('Platform admin access required'));
  }
  next();
}

module.exports = { requirePlatformAdmin };
