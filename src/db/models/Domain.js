'use strict';

module.exports = (sequelize, DataTypes) => {
  const Domain = sequelize.define(
    'Domain',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: false, field: 'website_id' },
      hostname: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      verificationToken: { type: DataTypes.STRING(100), allowNull: false, field: 'verification_token' },
      status: {
        type: DataTypes.ENUM('pending_verification', 'verified', 'active', 'failed'),
        allowNull: false,
        defaultValue: 'pending_verification',
      },
      isPrimary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_primary' },
      verifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'verified_at' },
    },
    { tableName: 'domains', indexes: [{ unique: true, fields: ['hostname'] }, { fields: ['website_id'] }] }
  );
  Domain.associate = (models) => {
    Domain.belongsTo(models.Website, { foreignKey: 'websiteId', as: 'website' });
  };
  return Domain;
};
