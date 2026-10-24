'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebhookEndpoint = sequelize.define(
    'WebhookEndpoint',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      url: { type: DataTypes.STRING(500), allowNull: false },
      events: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      // In clear, or null once sealed into signingSecretSealed (migration 714,
      // webhooks/signingSecretStore.js). Read only through that module.
      signingSecret: { type: DataTypes.STRING(100), allowNull: true, field: 'signing_secret' },
      signingSecretSealed: { type: DataTypes.TEXT, allowNull: true, field: 'signing_secret_sealed' },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      // { funnelIds, productIds } — only events about these (webhookFilter.js). Null = all.
      filter: { type: DataTypes.JSONB, allowNull: true },
      // [{ name, value: <sealed> }] sent with every delivery (migration 664, webhooks/customHeaders.js).
      customHeaders: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'custom_headers' },
      // Start of the current unbroken run of failed deliveries (webhookHealth.js).
      failingSince: { type: DataTypes.DATE, allowNull: true, field: 'failing_since' },
      disabledAt: { type: DataTypes.DATE, allowNull: true, field: 'disabled_at' },
      disabledReason: { type: DataTypes.STRING(60), allowNull: true, field: 'disabled_reason' },
    },
    { tableName: 'webhook_endpoints', indexes: [{ fields: ['workspace_id'] }] }
  );
  WebhookEndpoint.associate = (models) => {
    WebhookEndpoint.hasMany(models.WebhookDelivery, { foreignKey: 'endpointId', as: 'deliveries' });
  };
  return WebhookEndpoint;
};
