'use strict';

module.exports = (sequelize, DataTypes) => {
  // One component of a combo: a product, a fixed variant or one the shopper picks, and how many.
  // product_id / variant_id go null when either is deleted for good: the combo then stops selling.
  const ProductComboItem = sequelize.define(
    'ProductComboItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      comboId: { type: DataTypes.UUID, allowNull: false, field: 'combo_id' },
      productId: { type: DataTypes.UUID, allowNull: true, field: 'product_id' },
      variantId: { type: DataTypes.UUID, allowNull: true, field: 'variant_id' },
      pickVariant: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'pick_variant' },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: { min: 1, max: 100 } },
      position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    { tableName: 'product_combo_items' }
  );
  ProductComboItem.associate = (models) => {
    ProductComboItem.belongsTo(models.ProductCombo, { foreignKey: 'comboId', as: 'combo' });
    ProductComboItem.belongsTo(models.Product, { foreignKey: 'productId', as: 'product' });
    ProductComboItem.belongsTo(models.ProductVariant, { foreignKey: 'variantId', as: 'variant' });
  };
  return ProductComboItem;
};
