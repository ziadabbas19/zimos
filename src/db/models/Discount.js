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
      // The merchant's controls (migration 730, discounts/discountRules.js). Each default is the old behaviour.
      audience: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'any', validate: { isIn: [['any', 'new', 'existing']] } },
      customerPhones: { type: DataTypes.ARRAY(DataTypes.STRING(32)), allowNull: false, defaultValue: [], field: 'customer_phones' },
      vipTierIds: { type: DataTypes.ARRAY(DataTypes.STRING(64)), allowNull: false, defaultValue: [], field: 'vip_tier_ids' },
      schedule: { type: DataTypes.JSONB, allowNull: true },
      maxDiscountAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'max_discount_amount' },
      minQuantity: { type: DataTypes.INTEGER, allowNull: true, field: 'min_quantity' },
      excludedProductIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [], field: 'excluded_product_ids' },
      appliesToShipping: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'applies_to_shipping' },
      appliesToDiscounted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'applies_to_discounted' },
      combinesWithOffers: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'combines_with_offers' },
      strictCustomerLimit: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'strict_customer_limit' },
    },
    { tableName: 'discounts', indexes: [{ unique: true, fields: ['workspace_id', 'code'] }] }
  );
  Discount.associate = (models) => {
    Discount.hasMany(models.DiscountRedemption, { foreignKey: 'discountId', as: 'redemptions' });
  };
  return Discount;
};
