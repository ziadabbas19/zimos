'use strict';

module.exports = (sequelize, DataTypes) => {
  // An Offer is how a product is sold: it references one or more variants
  // with quantities (via OfferVariant) and defines the price the customer
  // pays. A "3-pack" offer might reference Variant A with quantity=3 at a
  // bundle price; buying it consumes 3 units of Variant A's inventory.
  const Offer = sequelize.define(
    'Offer',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      productId: { type: DataTypes.UUID, allowNull: false, field: 'product_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      pricingMode: {
        type: DataTypes.ENUM('fixed', 'computed'),
        allowNull: false,
        defaultValue: 'fixed',
        field: 'pricing_mode',
      },
      priceAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'price_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      badge: { type: DataTypes.STRING(100), allowNull: true },
      isDefault: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_default' },
      shippingOverride: { type: DataTypes.JSONB, allowNull: true, field: 'shipping_override' },
      status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
    },
    { tableName: 'offers', indexes: [{ fields: ['workspace_id'] }, { fields: ['product_id'] }] }
  );

  Offer.associate = (models) => {
    Offer.belongsTo(models.Product, { foreignKey: 'productId', as: 'product' });
    Offer.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Offer.hasMany(models.OfferVariant, { foreignKey: 'offerId', as: 'lines' });
  };

  return Offer;
};
