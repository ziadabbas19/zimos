'use strict';

module.exports = (sequelize, DataTypes) => {
  const CustomerAddress = sequelize.define(
    'CustomerAddress',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      customerId: { type: DataTypes.UUID, allowNull: false, field: 'customer_id' },
      country: { type: DataTypes.STRING(2), allowNull: false },
      province: { type: DataTypes.STRING(100), allowNull: true },
      city: { type: DataTypes.STRING(100), allowNull: false },
      addressLine: { type: DataTypes.STRING(500), allowNull: false, field: 'address_line' },
      postalCode: { type: DataTypes.STRING(20), allowNull: true, field: 'postal_code' },
      notes: { type: DataTypes.STRING(500), allowNull: true },
      isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_default' },
    },
    { tableName: 'customer_addresses', indexes: [{ fields: ['workspace_id', 'customer_id'] }] }
  );

  CustomerAddress.associate = (models) => {
    CustomerAddress.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
  };

  return CustomerAddress;
};
