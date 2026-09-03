'use strict';

const { AuthorizationError } = require('../errors/AppError');

/**
 * Requires req.tenant.hasPermission(permission) to be true. Must run after
 * resolveTenant. Every sensitive route declares its required permission
 * explicitly here rather than relying on the frontend to hide a button.
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.tenant || !req.tenant.hasPermission(permission)) {
      return next(new AuthorizationError(`Missing required permission: ${permission}`));
    }
    next();
  };
}

module.exports = { requirePermission };
