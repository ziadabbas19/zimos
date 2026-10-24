'use strict';

const db = require('../../db/models');
const { hasPlatformPermission } = require('../../core/security/platformPermissions');
const { STORE_PERMISSIONS, CONSOLE_PERMISSIONS, userRoom, storeRoom, consoleRoom } = require('./catalog');

/**
 * The rooms of each account, worked out from the database alone: its active
 * memberships and their roles (the rule of core/middleware/tenantContext: the
 * role's own list, or the owner's '*'), and its console permissions (the rule
 * of core/middleware/platformAdminGuard). Nothing a client sends names a room.
 *
 * Returns Map(userId → rooms) for the accounts that may connect: active and
 * not deleted, as core/middleware/authenticate requires. An account missing
 * from the map may not hold a socket.
 */
async function roomsByUser(userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const result = new Map();
  if (ids.length === 0) return result;
  const users = await db.User.findAll({
    where: { id: ids },
    attributes: ['id', 'status', 'deletedAt', 'platformRole', 'platformPermissions'],
  });
  for (const user of users) {
    if (user.status !== 'active' || user.deletedAt) continue;
    const rooms = [userRoom(user.id)];
    for (const permission of CONSOLE_PERMISSIONS) if (hasPlatformPermission(user, permission)) rooms.push(consoleRoom(permission));
    result.set(user.id, rooms);
  }
  if (result.size === 0) return result;
  const memberships = await db.Membership.findAll({
    where: { userId: [...result.keys()], status: 'active' },
    attributes: ['userId', 'workspaceId'],
    include: [{ model: db.Role, as: 'role', attributes: ['permissions'] }],
  });
  for (const membership of memberships) {
    const permissions = (membership.role && membership.role.permissions) || [];
    const rooms = result.get(membership.userId);
    for (const permission of STORE_PERMISSIONS) {
      if (permissions.includes('*') || permissions.includes(permission)) rooms.push(storeRoom(membership.workspaceId, permission));
    }
  }
  return result;
}

module.exports = { roomsByUser };
