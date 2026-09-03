'use strict';

module.exports = (sequelize, DataTypes) => {
  // Platform SaaS billing invoices — distinct from merchant-facing Invoice
  // (which bills the merchant's own customers).
  const BillingInvoice = sequelize.define(
    'BillingInvoice',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      status: { type: DataTypes.ENUM('pending', 'paid', 'failed'), allowNull: false, defaultValue: 'pending' },
      periodStart: { type: DataTypes.DATE, allowNull: false, field: 'period_start' },
      periodEnd: { type: DataTypes.DATE, allowNull: false, field: 'period_end' },
      paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
      failureReason: { type: DataTypes.STRING(300), allowNull: true, field: 'failure_reason' },
    },
    { tableName: 'billing_invoices', indexes: [{ fields: ['workspace_id'] }, { fields: ['subscription_id'] }] }
  );
  BillingInvoice.associate = (models) => {
    BillingInvoice.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', as: 'subscription' });
  };
  return BillingInvoice;
};
