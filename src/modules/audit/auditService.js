'use strict';

const db = require('../../db/models');
const { clientIp } = require('../../core/middleware/clientIp');

/**
 * The only function in the codebase that writes to audit_logs. No route
 * exposes update/delete for this model (see modules/audit/routes.js), so in
 * practice this insert-only function plus a DB-level REVOKE UPDATE, DELETE
 * on production (see docs/DEPLOYMENT.md) is what keeps the log append-only.
 */
async function recordAudit({
  workspaceId = null,
  actorUserId = null,
  action,
  entityType,
  entityId = null,
  req = null,
  before = null,
  after = null,
  metadata = null,
  transaction = null,
}) {
  const row = await db.AuditLog.create(
    {
      workspaceId,
      actorUserId,
      action,
      entityType,
      entityId: entityId ? String(entityId) : null,
      ipAddress: req ? clientIp(req) : null,
      userAgent: req ? req.headers['user-agent'] : null,
      beforeState: before,
      afterState: after,
      metadata,
    },
    transaction ? { transaction } : undefined
  );
  // Some audited changes are also domain events (product.updated, order.paid…):
  // core/outbox/auditEventBridge.js records them in the same transaction.
  await require('../../core/outbox/auditEventBridge').onAudit({ workspaceId, action, entityType, entityId, before, after, metadata, transaction });
  // Some are also console notifications (platformAdmin/platformNotificationService), in a savepoint; never throws.
  await require('../platformAdmin/platformNotificationService').onAudit({ workspaceId, actorUserId, action, entityType, entityId, before, after, metadata, transaction });
  // Some are also live updates to the console (realtime/realtimeEvents), only with REALTIME_ENABLED; never throws.
  await require('../realtime/realtimeEvents').onAudit({ workspaceId, action, entityId, transaction });
  // A change the storefront shows drops the store's 60-second cache once it commits.
  require('../storefront/storefrontCache').onAudit({ workspaceId, entityType, transaction });
  return row;
}

module.exports = { recordAudit };
