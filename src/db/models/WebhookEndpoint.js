'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebhookEndpoint = sequelize.define(
    'WebhookEndpoint',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      url: { type: DataTypes.STRING(500), allowNull: false },
      events: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      signingSecret: { type: DataTypes.STRING(100), allowNull: false, field: 'signing_secret' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'webhook_endpoints', indexes: [{ fields: ['workspace_id'] }] }
  );
  WebhookEndpoint.associate = (models) => {
    WebhookEndpoint.hasMany(models.WebhookDelivery, { foreignKey: 'endpointId', as: 'deliveries' });
  };
  return WebhookEndpoint;
};
