'use strict';

const { AuthorizationError } = require('../errors/AppError');
const { hasPlatformPermission } = require('../security/platformPermissions');

/**
 * Gates for the platform-console endpoints. They bypass workspace RBAC
 * entirely and check only the account's own platform permission set
 * (users.platform_permissions, see core/security/platformPermissions.js).
 * Run after `authenticate` / `authenticateFlexible`, which reload the user
 * on every request, so a role change applies to that user's next call.
 *
 * Every /admin route names the permission it needs; there is deliberately no
 * "any platform user" gate, so a route cannot be left open to agents by
 * forgetting to narrow it.
 *
 * Each guard carries what it asks for: tests/integration/adminRoutePermissions
 * reads it to walk every console route.
 */
function requireAnyPlatformPermission(permissions) {
  const guard = (req, res, next) => {
    if (!permissions.some((permission) => hasPlatformPermission(req.user, permission))) {
      return next(new AuthorizationError(`Missing required platform permission: ${permissions.join(' or ')}`));
    }
    next();
  };
  guard.platformPermissions = permissions;
  return guard;
}

function requirePlatformPermission(permission) {
  return requireAnyPlatformPermission([permission]);
}

module.exports = { requirePlatformPermission, requireAnyPlatformPermission };
