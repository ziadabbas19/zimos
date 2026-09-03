'use strict';

module.exports = (sequelize, DataTypes) => {
  // Customer identity is primarily keyed on normalized phone number, since
  // COD workflows in this market run on phone contact rather than email.
  // `phoneNormalized` is E.164-ish (digits only, country-code prefixed) and
  // is what uniqueness and lookups are based on; `phoneRaw` preserves what
  // the customer actually typed for display purposes.
  const Customer = sequelize.define(
    'Customer',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      phoneNormalized: { type: DataTypes.STRING(32), allowNull: false, field: 'phone_normalized' },
      phoneRaw: { type: DataTypes.STRING(32), allowNull: true, field: 'phone_raw' },
      alternatePhone: { type: DataTypes.STRING(32), allowNull: true, field: 'alternate_phone' },
      email: { type: DataTypes.STRING(255), allowNull: true },
      fullName: { type: DataTypes.STRING(200), allowNull: true, field: 'full_name' },
      marketingConsent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'marketing_consent' },
      isBlacklisted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_blacklisted' },
      blacklistReason: { type: DataTypes.STRING(300), allowNull: true, field: 'blacklist_reason' },
      segments: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      reliabilityScore: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100, field: 'reliability_score' },
      // Denormalized rolling counters, maintained by the orders module when
      // confirmation/fulfillment outcomes are recorded.
      totalOrders: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'total_orders' },
      totalRejectedOrders: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'total_rejected_orders' },
    },
    {
      tableName: 'customers',
      indexes: [
        { unique: true, fields: ['workspace_id', 'phone_normalized'] },
        { fields: ['workspace_id', 'is_blacklisted'] },
      ],
    }
  );

  Customer.associate = (models) => {
    Customer.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Customer.hasMany(models.CustomerAddress, { foreignKey: 'customerId', as: 'addresses' });
    Customer.hasMany(models.Order, { foreignKey: 'customerId', as: 'orders' });
  };

  return Customer;
};
