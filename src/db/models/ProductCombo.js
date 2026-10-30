'use strict';

module.exports = (sequelize, DataTypes) => {
  // Different products sold together at one price (migration 733, modules/combos).
  const ProductCombo = sequelize.define(
    'ProductCombo',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      imageUrl: { type: DataTypes.STRING(1000), allowNull: true, field: 'image_url' },
      status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'draft', validate: { isIn: [['draft', 'active', 'archived']] } },
      // fixed_price: price_value is one combo's price; percent_off: basis points; amount_off: minor units.
      pricingMode: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'fixed_price', field: 'pricing_mode', validate: { isIn: [['fixed_price', 'percent_off', 'amount_off']] } },
      priceValue: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'price_value' },
      // Empty: shown on the page of every product in it.
      showOnProductIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'show_on_product_ids' },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'product_combos' }
  );
  ProductCombo.associate = (models) => {
    ProductCombo.hasMany(models.ProductComboItem, { foreignKey: 'comboId', as: 'items' });
  };
  return ProductCombo;
};
