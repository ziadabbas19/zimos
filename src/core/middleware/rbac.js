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

/**
 * Requires at least one of `permissions`. For read endpoints that two
 * different screens legitimately need — e.g. the carrier list, used by the
 * shipping settings (shipping.manage) and by the create-shipment dialog
 * (orders.manage).
 */
function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.tenant || !permissions.some((permission) => req.tenant.hasPermission(permission))) {
      return next(new AuthorizationError(`Missing required permission: one of ${permissions.join(', ')}`));
    }
    next();
  };
}

module.exports = { requirePermission, requireAnyPermission };
