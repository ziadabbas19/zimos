'use strict';

module.exports = (sequelize, DataTypes) => {
  // Device notifications of one kind for one teammate, gathered until they are
  // sent as one (notifications/push/pushDigest.js, migration 728). `refs` holds
  // ids of the latest one only, never anything about a customer.
  const PushDigest = sequelize.define(
    'PushDigest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      type: { type: DataTypes.STRING(40), allowNull: false },
      groupKey: { type: DataTypes.STRING(120), allowNull: false, field: 'group_key' },
      count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      refs: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      firstAt: { type: DataTypes.DATE, allowNull: false, field: 'first_at' },
      lastAt: { type: DataTypes.DATE, allowNull: false, field: 'last_at' },
      flushAt: { type: DataTypes.DATE, allowNull: false, field: 'flush_at' },
    },
    {
      tableName: 'push_digests',
      indexes: [{ unique: true, fields: ['workspace_id', 'user_id', 'group_key'] }, { fields: ['flush_at'] }],
    }
  );
  return PushDigest;
};
