'use strict';

module.exports = (sequelize, DataTypes) => {
  const ShippingRate = sequelize.define(
    'ShippingRate',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      zoneId: { type: DataTypes.UUID, allowNull: false, field: 'zone_id' },
      name: { type: DataTypes.STRING(150), allowNull: false },
      rateType: {
        type: DataTypes.ENUM('flat', 'weight_based', 'quantity_based', 'order_value_based', 'free'),
        allowNull: false,
        field: 'rate_type',
      },
      // Interpretation depends on rateType, e.g.
      // weight_based: [{ upToGrams: 1000, amount: 5000 }, ...]
      // order_value_based: [{ minSubtotal: 0, amount: 5000 }, { minSubtotal: 100000, amount: 0 }]
      config: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      carrierCode: { type: DataTypes.STRING(100), allowNull: true, field: 'carrier_code' },
    },
    { tableName: 'shipping_rates', indexes: [{ fields: ['zone_id'] }] }
  );
  ShippingRate.associate = (models) => {
    ShippingRate.belongsTo(models.ShippingZone, { foreignKey: 'zoneId', as: 'zone' });
  };
  return ShippingRate;
};
