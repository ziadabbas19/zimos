'use strict';

module.exports = (sequelize, DataTypes) => {
  const TaxRate = sequelize.define(
    'TaxRate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(150), allowNull: false },
      country: { type: DataTypes.STRING(2), allowNull: true },
      region: { type: DataTypes.STRING(100), allowNull: true },
      rateBasisPoints: { type: DataTypes.INTEGER, allowNull: false, field: 'rate_basis_points' },
      appliesToShipping: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'applies_to_shipping' },
      pricesIncludeTax: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'prices_include_tax' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' }, // null = applies workspace-wide
    },
    { tableName: 'tax_rates', indexes: [{ fields: ['workspace_id'] }] }
  );
  return TaxRate;
};
