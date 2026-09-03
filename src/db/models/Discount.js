'use strict';

module.exports = (sequelize, DataTypes) => {
  const Discount = sequelize.define(
    'Discount',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      code: { type: DataTypes.STRING(100), allowNull: true }, // null = automatic discount
      type: {
        type: DataTypes.ENUM('percentage', 'fixed', 'free_shipping', 'buy_x_get_y'),
        allowNull: false,
      },
      value: { type: DataTypes.BIGINT, allowNull: true }, // basis points for %, minor units for fixed
      buyXGetYConfig: { type: DataTypes.JSONB, allowNull: true, field: 'buy_x_get_y_config' },
      minimumSubtotal: { type: DataTypes.BIGINT, allowNull: true, field: 'minimum_subtotal' },
      productRestrictions: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'product_restrictions' },
      collectionRestrictions: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'collection_restrictions' },
      customerRestrictions: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'customer_restrictions' },
      funnelRestrictions: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'funnel_restrictions' },
      startsAt: { type: DataTypes.DATE, allowNull: true, field: 'starts_at' },
      endsAt: { type: DataTypes.DATE, allowNull: true, field: 'ends_at' },
      usageLimit: { type: DataTypes.INTEGER, allowNull: true, field: 'usage_limit' },
      perCustomerLimit: { type: DataTypes.INTEGER, allowNull: true, field: 'per_customer_limit' },
      usageCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'usage_count' },
      stackable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: DataTypes.ENUM('active', 'disabled', 'archived'), allowNull: false, defaultValue: 'active' },
    },
    { tableName: 'discounts', indexes: [{ unique: true, fields: ['workspace_id', 'code'] }] }
  );
  Discount.associate = (models) => {
    Discount.hasMany(models.DiscountRedemption, { foreignKey: 'discountId', as: 'redemptions' });
  };
  return Discount;
};
