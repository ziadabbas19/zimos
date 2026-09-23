'use strict';

module.exports = (sequelize, DataTypes) => {
  // A merchant's own courier account — see migration 092. The encrypted
  // credentials are excluded from every default query and from toJSON, so a
  // row can't carry them into a response or an audit snapshot by accident;
  // the one reader that needs them uses the 'withCredentials' scope.
  const CarrierAccount = sequelize.define(
    'CarrierAccount',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      carrierCode: { type: DataTypes.STRING(50), allowNull: false, field: 'carrier_code' },
      credentialsEncrypted: { type: DataTypes.TEXT, allowNull: false, field: 'credentials_encrypted' },
      status: { type: DataTypes.ENUM('active', 'invalid'), allowNull: false, defaultValue: 'active' },
      webhookToken: { type: DataTypes.STRING(100), allowNull: false, field: 'webhook_token' },
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      lastVerifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_verified_at' },
    },
    {
      tableName: 'carrier_accounts',
      indexes: [
        { unique: true, fields: ['workspace_id', 'carrier_code'] },
        { unique: true, fields: ['webhook_token'] },
      ],
      defaultScope: { attributes: { exclude: ['credentialsEncrypted'] } },
      // Naming a scope replaces the default one, so this empty scope is
      // "every column, credentials included".
      scopes: { withCredentials: {} },
    }
  );

  CarrierAccount.prototype.toJSON = function toJSON() {
    const values = { ...this.get() };
    delete values.credentialsEncrypted;
    return values;
  };

  CarrierAccount.associate = (models) => {
    CarrierAccount.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
  };
  return CarrierAccount;
};
