'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store's cart rewards — see migrations 747 and 750 and modules/cartRewards.
  const CartRewardSettings = sequelize.define(
    'CartRewardSettings',
    {
      workspaceId: { type: DataTypes.UUID, primaryKey: true, allowNull: false, field: 'workspace_id' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      allowCouponStacking: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'allow_coupon_stacking' },
      tiers: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      trustItems: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'trust_items' },
      // The bar's look (migration 750, cartRewards/barAppearance.js); null = the theme's, as it always looked.
      barAppearance: { type: DataTypes.JSONB, allowNull: true, field: 'bar_appearance' },
    },
    { tableName: 'cart_reward_settings' }
  );

  CartRewardSettings.associate = (models) => {
    CartRewardSettings.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
  };

  return CartRewardSettings;
};
