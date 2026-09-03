'use strict';

module.exports = (sequelize, DataTypes) => {
  const ShippingZone = sequelize.define(
    'ShippingZone',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(150), allowNull: false },
      countries: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      regions: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
      excludedRegions: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [], field: 'excluded_regions' },
    },
    { tableName: 'shipping_zones', indexes: [{ fields: ['workspace_id'] }] }
  );
  ShippingZone.associate = (models) => {
    ShippingZone.hasMany(models.ShippingRate, { foreignKey: 'zoneId', as: 'rates' });
  };
  return ShippingZone;
};
