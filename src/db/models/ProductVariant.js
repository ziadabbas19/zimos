'use strict';

module.exports = (sequelize, DataTypes) => {
  // Stock lives on the variant, never on the offer (see OfferVariant, which
  // only records how many units of a variant an offer consumes). All stock
  // mutations MUST go through modules/inventory/inventoryService.js, which
  // uses row-level locking (SELECT ... FOR UPDATE) inside a transaction —
  // never direct increment/decrement calls from other modules.
  const ProductVariant = sequelize.define(
    'ProductVariant',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      sku: { type: DataTypes.STRING(100), allowNull: true },
      barcode: { type: DataTypes.STRING(100), allowNull: true },
      optionValues: {
        // e.g. { Color: 'Red', Size: 'M' }
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
        field: 'option_values',
      },
      priceAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'price_amount' },
      compareAtAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'compare_at_amount' },
      costAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'cost_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      stockOnHand: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'stock_on_hand' },
      reservedStock: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'reserved_stock' },
      allowOverselling: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'allow_overselling' },
      weightGrams: { type: DataTypes.INTEGER, allowNull: true, field: 'weight_grams' },
      dimensions: { type: DataTypes.JSONB, allowNull: true },
      status: {
        type: DataTypes.ENUM('active', 'archived'),
        allowNull: false,
        defaultValue: 'active',
      },
      // Optimistic-locking counter, incremented on every stock mutation, used
      // by inventoryService to detect and retry on concurrent-write races in
      // addition to the row lock (defense in depth).
      version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'product_variants',
      indexes: [
        { fields: ['workspace_id'] },
        { fields: ['product_id'] },
        { unique: true, fields: ['workspace_id', 'sku'], where: { sku: { [require('sequelize').Op.ne]: null } } },
      ],
    }
  );

  ProductVariant.associate = (models) => {
    ProductVariant.belongsTo(models.Product, { foreignKey: 'productId', as: 'product' });
    ProductVariant.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    ProductVariant.hasMany(models.OfferVariant, { foreignKey: 'variantId', as: 'offerLines' });
    ProductVariant.hasMany(models.InventoryMovement, { foreignKey: 'variantId', as: 'movements' });
  };

  ProductVariant.prototype.availableStock = function availableStock() {
    return this.stockOnHand - this.reservedStock;
  };

  return ProductVariant;
};
