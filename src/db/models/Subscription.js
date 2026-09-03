'use strict';

module.exports = (sequelize, DataTypes) => {
  const Subscription = sequelize.define(
    'Subscription',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, unique: true, field: 'workspace_id' },
      planId: { type: DataTypes.UUID, allowNull: true, field: 'plan_id' },
      // Populated once a real payment gateway is connected.
      externalSubscriptionId: { type: DataTypes.STRING(200), allowNull: true, field: 'external_subscription_id' },
      externalProvider: { type: DataTypes.STRING(50), allowNull: true, field: 'external_provider' },
      billingCycle: { type: DataTypes.ENUM('monthly', 'yearly'), allowNull: false, defaultValue: 'monthly', field: 'billing_cycle' },
      status: {
        type: DataTypes.ENUM('trialing', 'active', 'past_due', 'suspended', 'cancelled'),
        allowNull: false,
        defaultValue: 'trialing',
      },
      trialEndsAt: { type: DataTypes.DATE, allowNull: true, field: 'trial_ends_at' },
      currentPeriodStart: { type: DataTypes.DATE, allowNull: false, field: 'current_period_start' },
      currentPeriodEnd: { type: DataTypes.DATE, allowNull: false, field: 'current_period_end' },
      graceUntil: { type: DataTypes.DATE, allowNull: true, field: 'grace_until' },
      cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'cancel_at_period_end' },
    },
    { tableName: 'subscriptions', indexes: [{ unique: true, fields: ['workspace_id'] }] }
  );
  Subscription.associate = (models) => {
    Subscription.belongsTo(models.Plan, { foreignKey: 'planId', as: 'plan' });
    Subscription.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Subscription.hasMany(models.BillingInvoice, { foreignKey: 'subscriptionId', as: 'invoices' });
  };
  return Subscription;
};
