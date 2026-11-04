'use strict';

const db = require('../../db/models');
const { ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const access = require('../workspaces/workspaceAccessService');
const { invalidateAfterCommit } = require('../storefront/storefrontCache');

/**
 * Manual store suspension (workspaces.manage). Unrelated to billing:
 *
 *   - it sets workspaces.status = 'suspended' with who, when and why, and
 *     never touches the subscription;
 *   - a suspended store is restricted exactly like an unpaid one past its
 *     grace day (storefront unavailable, no new products or funnels), through
 *     the same workspaceAccessService;
 *   - reactivating lifts only the suspension: a store that is also unpaid
 *     past its grace day stays restricted, and paying never lifts a
 *     suspension.
 *
 * Both actions need a reason, and both are audited as platform-level entries
 * (workspace_id NULL, the workspace in the metadata) like the other admin
 * writes, so the admin's note stays out of the merchant's own audit log.
 */

function suspensionView(workspace, suspendedBy = null) {
  return {
    status: workspace.status,
    suspended: workspace.status === 'suspended',
    suspendedAt: workspace.suspendedAt,
    suspensionReason: workspace.suspensionReason,
    suspendedBy: suspendedBy ? { id: suspendedBy.id, fullName: suspendedBy.fullName } : null,
  };
}

async function lockWorkspace(workspaceId, transaction) {
  const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!workspace) throw new NotFoundError('Workspace');
  return workspace;
}

async function suspend(workspaceId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await lockWorkspace(workspaceId, transaction);
    if (workspace.status === 'suspended') {
      throw new ConflictError('This store is already suspended.', 'WORKSPACE_ALREADY_SUSPENDED');
    }
    if (workspace.status !== 'active') {
      throw new ConflictError(`A ${workspace.status} store cannot be suspended.`, 'WORKSPACE_NOT_ACTIVE');
    }

    await workspace.update(
      { status: 'suspended', suspendedAt: new Date(), suspendedByUserId: req.user.id, suspensionReason: reason },
      { transaction }
    );
    await recordAudit({
      actorUserId: req.user.id,
      action: 'workspace.suspend',
      entityType: 'Workspace',
      entityId: workspace.id,
      before: { status: 'active' },
      after: { status: 'suspended' },
      metadata: { workspaceId: workspace.id, reason },
      req,
      transaction,
    });
    // Its pages go from every cache at once, the edge's included: the store is closed now.
    invalidateAfterCommit(workspace.id, transaction);
    return suspensionView(workspace, req.user);
  });
}

async function reactivate(workspaceId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await lockWorkspace(workspaceId, transaction);
    if (workspace.status !== 'suspended') {
      throw new ConflictError('This store is not suspended.', 'WORKSPACE_NOT_SUSPENDED');
    }

    const suspendedFor = workspace.suspensionReason;
    await workspace.update(
      { status: 'active', suspendedAt: null, suspendedByUserId: null, suspensionReason: null },
      { transaction }
    );
    await recordAudit({
      actorUserId: req.user.id,
      action: 'workspace.reactivate',
      entityType: 'Workspace',
      entityId: workspace.id,
      before: { status: 'suspended' },
      after: { status: 'active' },
      metadata: { workspaceId: workspace.id, reason, suspensionReason: suspendedFor },
      req,
      transaction,
    });
    invalidateAfterCommit(workspace.id, transaction);
    return suspensionView(workspace);
  });
}

/**
 * The console's view of a store's access: the manual suspension and the
 * billing lifecycle side by side, and whether the store is restricted and
 * why.
 */
async function getStoreAccess(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, {
    attributes: ['id', 'status', 'suspendedAt', 'suspendedByUserId', 'suspensionReason'],
  });
  if (!workspace) throw new NotFoundError('Workspace');
  const suspendedBy = workspace.suspendedByUserId
    ? await db.User.findByPk(workspace.suspendedByUserId, { attributes: ['id', 'fullName'] })
    : null;
  const state = await access.accessFor(workspaceId, { workspace });
  return {
    ...access.serializeAccess(state),
    suspension: suspensionView(workspace, suspendedBy),
  };
}

module.exports = { suspend, reactivate, getStoreAccess };
