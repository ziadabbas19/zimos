'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store's cart rewards — see migration 747 and modules/cartRewards.
  const CartRewardSettings = sequelize.define(
    'CartRewardSettings',
    {
      workspaceId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: 'workspace_id' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      allowCouponStacking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'allow_coupon_stacking' },
      tiers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      trustItems: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'trust_items' },
    },
    { tableName: 'cart_reward_settings' }
  );

  CartRewardSettings.associate = (models) => {
    CartRewardSettings.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
  };

  return CartRewardSettings;
};
