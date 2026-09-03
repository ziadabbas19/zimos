'use strict';

module.exports = (sequelize, DataTypes) => {
  // A Workspace is the tenant boundary. Every workspace-owned resource in the
  // system carries a workspaceId foreign key and every query touching such a
  // resource MUST be scoped by it (see core/middleware/tenantContext.js and
  // core/utils/scopedRepository.js). Nothing about this is optional.
  const Workspace = sequelize.define(
    'Workspace',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      name: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(200), allowNull: false, unique: true },
      ownerUserId: { type: DataTypes.UUID, allowNull: false, field: 'owner_user_id' },
      status: {
        type: DataTypes.ENUM('active', 'suspended', 'closed'),
        allowNull: false,
        defaultValue: 'active',
      },
      defaultCurrency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP', field: 'default_currency' },
      defaultLocale: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ar-EG', field: 'default_locale' },
      timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'Africa/Cairo' },
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // Storefront branding.
      logoUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'logo_url' },
      tagline: { type: DataTypes.STRING(300), allowNull: true },
      // Opaque theme blob owned by the storefront frontend; stored as-is, never validated.
      themeSettings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'theme_settings' },
    },
    {
      tableName: 'workspaces',
      indexes: [{ unique: true, fields: ['slug'] }],
    }
  );

  Workspace.associate = (models) => {
    Workspace.belongsTo(models.User, { foreignKey: 'ownerUserId', as: 'owner' });
    Workspace.hasMany(models.Membership, { foreignKey: 'workspaceId', as: 'memberships' });
    Workspace.hasMany(models.Role, { foreignKey: 'workspaceId', as: 'roles' });
    Workspace.hasOne(models.Subscription, { foreignKey: 'workspaceId', as: 'subscription' });
  };

  return Workspace;
};
