'use strict';

module.exports = (sequelize, DataTypes) => {
  // Append-only by convention: no update/delete route is ever exposed for
  // this model (see modules/audit/routes.js, which is read-only), and the
  // application DB user should additionally be denied UPDATE/DELETE on this
  // table at the database level in production (see docs/DEPLOYMENT.md).
  const AuditLog = sequelize.define(
    'AuditLog',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: true, field: 'workspace_id' },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
      action: { type: DataTypes.STRING(100), allowNull: false },
      entityType: { type: DataTypes.STRING(100), allowNull: false, field: 'entity_type' },
      entityId: { type: DataTypes.STRING(100), allowNull: true, field: 'entity_id' },
      ipAddress: { type: DataTypes.STRING(64), allowNull: true, field: 'ip_address' },
      userAgent: { type: DataTypes.STRING(500), allowNull: true, field: 'user_agent' },
      beforeState: { type: DataTypes.JSONB, allowNull: true, field: 'before_state' },
      afterState: { type: DataTypes.JSONB, allowNull: true, field: 'after_state' },
      metadata: { type: DataTypes.JSONB, allowNull: true },
    },
    {
      tableName: 'audit_logs',
      updatedAt: false,
      indexes: [
        { fields: ['workspace_id', 'created_at'] },
        { fields: ['entity_type', 'entity_id'] },
        { fields: ['actor_user_id'] },
      ],
    }
  );

  return AuditLog;
};
