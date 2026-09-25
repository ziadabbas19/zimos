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
        // Online attempts: initialized (shopper sent to the gateway) ->
        // captured | failed | expired | cancelled (replaced by a retry, or the
        // shopper switched to COD). See migration 100.
        type: DataTypes.ENUM(
          'initialized',
          'authorized',
          'captured',
          'failed',
          'refunded',
          'partially_refunded',
          'expired',
          'cancelled'
        ),
        allowNull: false,
        defaultValue: 'initialized',
      },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      providerReference: { type: DataTypes.STRING(200), allowNull: true, field: 'provider_reference' },
      maskedDisplay: { type: DataTypes.STRING(100), allowNull: true, field: 'masked_display' },
      failureReason: { type: DataTypes.STRING(300), allowNull: true, field: 'failure_reason' },
      // Gateway attempts only — see migration 099.
      method: { type: DataTypes.STRING(20), allowNull: true },
      mode: { type: DataTypes.STRING(10), allowNull: true },
      providerOrderId: { type: DataTypes.STRING(100), allowNull: true, field: 'provider_order_id' },
      providerTransactionId: { type: DataTypes.STRING(100), allowNull: true, field: 'provider_transaction_id' },
      redirectUrl: { type: DataTypes.TEXT, allowNull: true, field: 'redirect_url' },
      returnUrl: { type: DataTypes.TEXT, allowNull: true, field: 'return_url' },
      expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
      paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
      lastInquiredAt: { type: DataTypes.DATE, allowNull: true, field: 'last_inquired_at' },
    },
    { tableName: 'payments', indexes: [{ fields: ['workspace_id'] }, { fields: ['order_id'] }] }
  );
  Payment.associate = (models) => {
    Payment.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
  };
  return Payment;
};
