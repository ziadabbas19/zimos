'use strict';

module.exports = (sequelize, DataTypes) => {
  const FeatureFlag = sequelize.define(
    'FeatureFlag',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      key: { type: DataTypes.STRING(120), allowNull: false, unique: true },
      description: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      // 0-100. Ignored when `enabled` is false.
      rollout: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      targetWorkspaceIds: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
        field: 'target_workspace_ids',
      },
    },
    { tableName: 'feature_flags', indexes: [{ unique: true, fields: ['key'] }] }
  );
  return FeatureFlag;
};
