'use strict';

const db = require('../../db/models');

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
  return db.AuditLog.create(
    {
      workspaceId,
      actorUserId,
      action,
      entityType,
      entityId: entityId ? String(entityId) : null,
      ipAddress: req ? req.ip : null,
      userAgent: req ? req.headers['user-agent'] : null,
      beforeState: before,
      afterState: after,
      metadata,
    },
    transaction ? { transaction } : undefined
  );
}

module.exports = { recordAudit };
