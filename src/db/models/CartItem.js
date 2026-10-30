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
      // The shopper's answers to the product's custom fields, snapshotted with
      // their labels (catalog/customFields.js). Null: none.
      customizations: { type: DataTypes.JSONB, allowNull: true },
      // Menu options picked on this line, [{ groupId, choiceIds }] (migration 218, catalog/menuOptions.js).
      selectedOptions: { type: DataTypes.JSONB, allowNull: true, field: 'selected_options' },
      // A whole combo on one line (migration 733, modules/combos): [{ itemId, variantId }] for the
      // components whose variant the shopper picks; variantId is then the first component's.
      comboId: { type: DataTypes.UUID, allowNull: true, field: 'combo_id' },
      comboSelection: { type: DataTypes.JSONB, allowNull: true, field: 'combo_selection' },
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
