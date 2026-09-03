'use strict';

module.exports = (sequelize, DataTypes) => {
  const ReturnRequest = sequelize.define(
    'ReturnRequest',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      reason: { type: DataTypes.STRING(300), allowNull: false },
      status: {
        type: DataTypes.ENUM('requested', 'approved', 'rejected', 'received', 'refunded'),
        allowNull: false,
        defaultValue: 'requested',
      },
      items: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }, // [{ orderItemId, quantity }]
      // Restocking is an explicit separate action (see returnService.restock),
      // never automatic on refund/approval.
      restockedAt: { type: DataTypes.DATE, allowNull: true, field: 'restocked_at' },
    },
    { tableName: 'return_requests', indexes: [{ fields: ['workspace_id'] }, { fields: ['order_id'] }] }
  );
  ReturnRequest.associate = (models) => {
    ReturnRequest.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return ReturnRequest;
};
