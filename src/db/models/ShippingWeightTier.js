'use strict';

module.exports = (sequelize, DataTypes) => {
  // One of a workspace's weight tiers — see migration 096. upToGrams is the
  // tier's inclusive upper bound; NULL (last tier only) means open ended.
  const ShippingWeightTier = sequelize.define(
    'ShippingWeightTier',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      upToGrams: { type: DataTypes.INTEGER, allowNull: true, field: 'up_to_grams' },
      position: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'shipping_weight_tiers', indexes: [{ fields: ['workspace_id', 'position'] }] }
  );
  ShippingWeightTier.associate = (models) => {
    ShippingWeightTier.hasMany(models.ShippingZoneTierPrice, { foreignKey: 'tierId', as: 'zonePrices' });
  };
  return ShippingWeightTier;
};
