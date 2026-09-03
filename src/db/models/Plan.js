'use strict';

module.exports = (sequelize, DataTypes) => {
  const Plan = sequelize.define(
    'Plan',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      key: { type: DataTypes.STRING(50), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(150), allowNull: false },
      monthlyPriceAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'monthly_price_amount' },
      yearlyPriceAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'yearly_price_amount' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'USD' },
      trialDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 14, field: 'trial_days' },
      // Soft quotas — enforced as warnings/upsell prompts, never as an order-intake blocker.
      softOrderQuota: { type: DataTypes.INTEGER, allowNull: true, field: 'soft_order_quota' },
      features: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'plans' }
  );
  return Plan;
};
