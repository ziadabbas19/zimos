'use strict';

module.exports = (sequelize, DataTypes) => {
  // Generic idempotency store, usable by any mutating endpoint (order
  // creation, webhook-triggered order operations, etc). The unique
  // constraint on (workspace_id, scope, key) is what actually prevents
  // duplicate processing under concurrent retries — see
  // core/middleware/idempotency.js, which inserts a row *before* doing the
  // work and relies on the DB to reject a concurrent duplicate insert.
  const IdempotencyKey = sequelize.define(
    'IdempotencyKey',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      scope: { type: DataTypes.STRING(100), allowNull: false }, // e.g. "order.create"
      key: { type: DataTypes.STRING(200), allowNull: false },
      requestHash: { type: DataTypes.STRING(64), allowNull: false, field: 'request_hash' },
      status: {
        type: DataTypes.ENUM('processing', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'processing',
      },
      responseStatus: { type: DataTypes.INTEGER, allowNull: true, field: 'response_status' },
      responseBody: { type: DataTypes.JSONB, allowNull: true, field: 'response_body' },
    },
    {
      tableName: 'idempotency_keys',
      indexes: [{ unique: true, fields: ['workspace_id', 'scope', 'key'] }],
    }
  );

  return IdempotencyKey;
};
