'use strict';

module.exports = (sequelize, DataTypes) => {
  // One choice of an option group, with the price it adds — migration 218, catalog/menuOptions.js.
  const ProductOptionChoice = sequelize.define(
    'ProductOptionChoice',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      groupId: { type: DataTypes.UUID, allowNull: false, field: 'group_id' },
      name: { type: DataTypes.STRING(100), allowNull: false },
      priceDeltaAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'price_delta_amount' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'sort_order' },
      // The choice's code in the merchant's own till / kitchen system (migration 715); never shown to shoppers.
      externalCode: { type: DataTypes.STRING(120), allowNull: true, field: 'external_code' },
    },
    { tableName: 'product_option_choices' }
  );
  ProductOptionChoice.associate = (models) => {
    ProductOptionChoice.belongsTo(models.ProductOptionGroup, { foreignKey: 'groupId', as: 'group' });
  };
  return ProductOptionChoice;
};
