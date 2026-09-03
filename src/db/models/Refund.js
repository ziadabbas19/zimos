'use strict';

module.exports = (sequelize, DataTypes) => {
  const Refund = sequelize.define(
    'Refund',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      paymentId: { type: DataTypes.UUID, allowNull: true, field: 'payment_id' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      reason: { type: DataTypes.STRING(300), allowNull: true },
      status: { type: DataTypes.ENUM('pending', 'processed', 'failed'), allowNull: false, defaultValue: 'pending' },
      creditNoteId: { type: DataTypes.UUID, allowNull: true, field: 'credit_note_id' },
      processedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'processed_by_user_id' },
    },
    { tableName: 'refunds', indexes: [{ fields: ['workspace_id'] }, { fields: ['order_id'] }] }
  );
  Refund.associate = (models) => {
    Refund.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    Refund.belongsTo(models.Payment, { foreignKey: 'paymentId', as: 'payment' });
  };
  return Refund;
};
