'use strict';

module.exports = (sequelize, DataTypes) => {
  const CartItem = sequelize.define(
    'CartItem',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      cartId: { type: DataTypes.UUID, allowNull: false, field: 'cart_id' },
      offerId: { type: DataTypes.UUID, allowNull: true, field: 'offer_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: { min: 1 } },
      // Snapshot of unit price AT THE TIME OF ADDING, for display only.
      // Checkout always re-prices from the live catalog server-side — this
      // field is never trusted for totals calculation.
      unitPriceSnapshot: { type: DataTypes.BIGINT, allowNull: false, field: 'unit_price_snapshot' },
      isOrderBump: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_order_bump' },
    },
    { tableName: 'cart_items', indexes: [{ fields: ['cart_id'] }] }
  );

  CartItem.associate = (models) => {
    CartItem.belongsTo(models.Cart, { foreignKey: 'cartId', as: 'cart' });
    CartItem.belongsTo(models.ProductVariant, { foreignKey: 'variantId', as: 'variant' });
    CartItem.belongsTo(models.Offer, { foreignKey: 'offerId', as: 'offer' });
  };

  return CartItem;
};
