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
      // 'suspended' is a manual suspension by a platform admin (migration 111),
      // independent of billing: the store is restricted until reactivated.
      status: {
        type: DataTypes.ENUM('active', 'suspended', 'closed'),
        allowNull: false,
        defaultValue: 'active',
      },
      suspendedAt: { type: DataTypes.DATE, allowNull: true, field: 'suspended_at' },
      suspendedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'suspended_by_user_id' },
      // An internal note from the admin; never shown to the merchant.
      suspensionReason: { type: DataTypes.TEXT, allowNull: true, field: 'suspension_reason' },
      defaultCurrency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP', field: 'default_currency' },
      defaultLocale: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ar-EG', field: 'default_locale' },
      timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'Africa/Cairo' },
      settings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      // Storefront branding.
      logoUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'logo_url' },
      tagline: { type: DataTypes.STRING(300), allowNull: true },
      // Opaque theme blob owned by the storefront frontend; stored as-is, never validated.
      themeSettings: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'theme_settings' },
      // What the store sells, from the store setup step (migration 753;
      // workspaces/businessTypes.js). Optional; the text only with "other".
      businessType: { type: DataTypes.STRING(32), allowNull: true, field: 'business_type' },
      businessTypeOther: { type: DataTypes.STRING(80), allowNull: true, field: 'business_type_other' },
    },
    {
      tableName: 'workspaces',
      indexes: [{ unique: true, fields: ['slug'] }],
    }
  );

  // The merchant dashboard serializes workspaces whole (GET /workspaces and
  // friends). Who suspended a store, and the admin's note, are the platform's
  // business, so they never leave through JSON; platform-admin code reads the
  // attributes directly.
  const baseToJSON = Workspace.prototype.toJSON;
  Workspace.prototype.toJSON = function toJSON() {
    const json = baseToJSON.call(this);
    delete json.suspensionReason;
    delete json.suspendedByUserId;
    return json;
  };

  Workspace.associate = (models) => {
    Workspace.belongsTo(models.User, { foreignKey: 'ownerUserId', as: 'owner' });
    Workspace.hasMany(models.Membership, { foreignKey: 'workspaceId', as: 'memberships' });
    Workspace.hasMany(models.Role, { foreignKey: 'workspaceId', as: 'roles' });
    Workspace.hasOne(models.Subscription, { foreignKey: 'workspaceId', as: 'subscription' });
  };

  return Workspace;
};
