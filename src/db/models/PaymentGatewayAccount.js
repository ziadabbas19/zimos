'use strict';

module.exports = (sequelize, DataTypes) => {
  // A merchant's own payment gateway account — see migration 099. Like
  // CarrierAccount, the encrypted credentials are excluded from every default
  // query and from toJSON; the one reader that needs them uses the
  // 'withCredentials' scope.
  const PaymentGatewayAccount = sequelize.define(
    'PaymentGatewayAccount',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      providerCode: { type: DataTypes.STRING(50), allowNull: false, field: 'provider_code' },
      credentialsEncrypted: { type: DataTypes.TEXT, allowNull: false, field: 'credentials_encrypted' },
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      mode: { type: DataTypes.STRING(10), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
      webhookToken: { type: DataTypes.STRING(64), allowNull: false, field: 'webhook_token' },
      lastVerifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_verified_at' },
      lastWebhookAt: { type: DataTypes.DATE, allowNull: true, field: 'last_webhook_at' },
    },
    {
      tableName: 'payment_gateway_accounts',
      indexes: [
        { unique: true, fields: ['workspace_id', 'provider_code'] },
        { unique: true, fields: ['webhook_token'] },
      ],
      defaultScope: { attributes: { exclude: ['credentialsEncrypted'] } },
      scopes: { withCredentials: {} },
    }
  );

  PaymentGatewayAccount.prototype.toJSON = function toJSON() {
    const values = { ...this.get() };
    delete values.credentialsEncrypted;
    return values;
  };

  PaymentGatewayAccount.associate = (models) => {
    PaymentGatewayAccount.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
  };
  return PaymentGatewayAccount;
};
