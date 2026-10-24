'use strict';

module.exports = (sequelize, DataTypes) => {
  // An accepted order an API key confirmed it received (migration 716, publicApi/acceptedOrdersFeed.js).
  const ApiKeyOrderAck = sequelize.define(
    'ApiKeyOrderAck',
    {
      apiKeyId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'api_key_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'order_id' },
      ackedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'acked_at' },
    },
    { tableName: 'api_key_order_acks', timestamps: false }
  );
  return ApiKeyOrderAck;
};
