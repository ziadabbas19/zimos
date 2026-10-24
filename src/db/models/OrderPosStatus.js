'use strict';

module.exports = (sequelize, DataTypes) => {
  // Where an order stands in the merchant's till / kitchen, as that system reports it (migration 717, publicApi/posStatus.js).
  const OrderPosStatus = sequelize.define(
    'OrderPosStatus',
    {
      orderId: { type: DataTypes.UUID, allowNull: false, primaryKey: true, field: 'order_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      status: { type: DataTypes.STRING(20), allowNull: false },
      reference: { type: DataTypes.STRING(120), allowNull: true },
      apiKeyId: { type: DataTypes.UUID, allowNull: true, field: 'api_key_id' },
    },
    { tableName: 'order_pos_statuses' }
  );
  return OrderPosStatus;
};
