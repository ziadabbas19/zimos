'use strict';

module.exports = (sequelize, DataTypes) => {
  // What a shipping zone charges for one weight tier, in minor units.
  const ShippingZoneTierPrice = sequelize.define(
    'ShippingZoneTierPrice',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      zoneId: { type: DataTypes.UUID, allowNull: false, field: 'zone_id' },
      tierId: { type: DataTypes.UUID, allowNull: false, field: 'tier_id' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
    },
    {
      tableName: 'shipping_zone_tier_prices',
      indexes: [{ unique: true, fields: ['zone_id', 'tier_id'] }, { fields: ['tier_id'] }],
    }
  );
  ShippingZoneTierPrice.associate = (models) => {
    ShippingZoneTierPrice.belongsTo(models.ShippingZone, { foreignKey: 'zoneId', as: 'zone' });
    ShippingZoneTierPrice.belongsTo(models.ShippingWeightTier, { foreignKey: 'tierId', as: 'tier' });
  };
  return ShippingZoneTierPrice;
};
