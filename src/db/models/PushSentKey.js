'use strict';

module.exports = (sequelize, DataTypes) => {
  // What already reached a teammate's devices (notifications/push/pushDigest.js,
  // migration 728): the same key is sent once. Removed after 3 days.
  const PushSentKey = sequelize.define(
    'PushSentKey',
    {
      workspaceId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: 'workspace_id' },
      userId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: 'user_id' },
      dedupeKey: { type: DataTypes.STRING(200), primaryKey: true, allowNull: false, field: 'dedupe_key' },
    },
    { tableName: 'push_sent_keys', updatedAt: false, indexes: [{ fields: ['created_at'] }] }
  );
  return PushSentKey;
};
