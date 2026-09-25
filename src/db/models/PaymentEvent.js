'use strict';

module.exports = (sequelize, DataTypes) => {
  // The payment callback inbox — see migration 099 and
  // modules/payments/paymentEventService.js.
  const PaymentEvent = sequelize.define(
    'PaymentEvent',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      accountId: { type: DataTypes.UUID, allowNull: true, field: 'account_id' },
      providerCode: { type: DataTypes.STRING(50), allowNull: false, field: 'provider_code' },
      eventKey: { type: DataTypes.STRING(200), allowNull: false, field: 'event_key' },
      // 'webhook' | 'redirect' | 'inquiry'
      source: { type: DataTypes.STRING(20), allowNull: false },
      // 'payment' | 'refund' | 'void'
      kind: { type: DataTypes.STRING(20), allowNull: true },
      providerOrderId: { type: DataTypes.STRING(100), allowNull: true, field: 'provider_order_id' },
      providerTransactionId: { type: DataTypes.STRING(100), allowNull: true, field: 'provider_transaction_id' },
      paymentId: { type: DataTypes.UUID, allowNull: true, field: 'payment_id' },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      payload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      processedAt: { type: DataTypes.DATE, allowNull: true, field: 'processed_at' },
      outcome: { type: DataTypes.STRING(60), allowNull: true },
      error: { type: DataTypes.STRING(500), allowNull: true },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    },
    {
      tableName: 'payment_events',
      indexes: [{ unique: true, fields: ['provider_code', 'event_key'] }],
    }
  );
  return PaymentEvent;
};
