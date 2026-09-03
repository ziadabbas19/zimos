'use strict';

module.exports = (sequelize, DataTypes) => {
  // Redemptions are inserted inside the same transaction that increments
  // Discount.usageCount, with the workspace/customer usage caps checked via
  // COUNT(*) FOR UPDATE on this table — see
  // modules/discounts/discountService.js#redeem — so concurrent checkouts
  // can never both succeed past a usage limit.
  const DiscountRedemption = sequelize.define(
    'DiscountRedemption',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      discountId: { type: DataTypes.UUID, allowNull: false, field: 'discount_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      amountAllocated: { type: DataTypes.BIGINT, allowNull: false, field: 'amount_allocated' },
    },
    { tableName: 'discount_redemptions', updatedAt: false, indexes: [{ fields: ['discount_id'] }, { fields: ['order_id'] }] }
  );
  DiscountRedemption.associate = (models) => {
    DiscountRedemption.belongsTo(models.Discount, { foreignKey: 'discountId', as: 'discount' });
    DiscountRedemption.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return DiscountRedemption;
};
