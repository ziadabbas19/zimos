'use strict';

module.exports = (sequelize, DataTypes) => {
  // `providerCode` selects the adapter in modules/payments/providers/*
  // (mock, cod, and real gateways added later). Card numbers/CVVs are NEVER
  // persisted anywhere in this schema — only the provider's opaque
  // reference and a masked display string, if any.
  const Payment = sequelize.define(
    'Payment',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      providerCode: { type: DataTypes.STRING(50), allowNull: false, field: 'provider_code' },
      status: {
        type: DataTypes.ENUM('initialized', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'),
        allowNull: false,
        defaultValue: 'initialized',
      },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      providerReference: { type: DataTypes.STRING(200), allowNull: true, field: 'provider_reference' },
      maskedDisplay: { type: DataTypes.STRING(100), allowNull: true, field: 'masked_display' },
      failureReason: { type: DataTypes.STRING(300), allowNull: true, field: 'failure_reason' },
    },
    { tableName: 'payments', indexes: [{ fields: ['workspace_id'] }, { fields: ['order_id'] }] }
  );
  Payment.associate = (models) => {
    Payment.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return Payment;
};
