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
 * Every /admin route names the permission it needs, so a route cannot be left
 * open to agents by forgetting to narrow it. The one exception is
 * requireConsoleAccount, for what is about the account itself and filters by
 * permission further in.
 *
 * Each guard carries what it asks for: tests/integration/adminRoutePermissions
 * reads it to walk every console route, and lists the routes allowed the
 * exception.
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

/** Any account with a console role, whatever it holds. */
function requireConsoleAccount(req, res, next) {
  if (!req.user || !req.user.platformRole) {
    return next(new AuthorizationError('This needs a console account'));
  }
  next();
}
requireConsoleAccount.consoleAccount = true;

module.exports = { requirePlatformPermission, requireAnyPlatformPermission, requireConsoleAccount };
