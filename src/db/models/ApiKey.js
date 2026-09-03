'use strict';

module.exports = (sequelize, DataTypes) => {
  // Only a SHA-256 hash of the raw secret is stored. The raw secret is
  // returned to the caller exactly once, at creation time (see
  // modules/apiKeys/apiKeyService.js).
  const ApiKey = sequelize.define(
    'ApiKey',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(150), allowNull: false },
      keyPrefix: { type: DataTypes.STRING(12), allowNull: false, field: 'key_prefix' },
      secretHash: { type: DataTypes.STRING(64), allowNull: false, field: 'secret_hash' },
      scopes: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      rateLimitPerMinute: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 60, field: 'rate_limit_per_minute' },
      lastUsedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_used_at' },
      revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
      createdByUserId: { type: DataTypes.UUID, allowNull: false, field: 'created_by_user_id' },
    },
    { tableName: 'api_keys', indexes: [{ fields: ['workspace_id'] }, { unique: true, fields: ['key_prefix'] }] }
  );
  ApiKey.associate = (models) => {
    ApiKey.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
  };
  return ApiKey;
};
