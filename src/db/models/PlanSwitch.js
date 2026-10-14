'use strict';

module.exports = (sequelize, DataTypes) => {
  // A merchant changing plan by themselves (migration 702,
  // billing/planSwitchService): an upgrade waiting for its charge, a
  // downgrade waiting for the end of the paid period, and what became of
  // each. At most one open (pending or scheduled) per subscription.
  const PlanSwitch = sequelize.define(
    'PlanSwitch',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
      // upgrade | move | scheduled | immediate (billing/planSwitchRules.KINDS)
      kind: { type: DataTypes.STRING(12), allowNull: false },
      // pending | scheduled | applied | cancelled | replaced | expired | dropped
      status: { type: DataTypes.STRING(12), allowNull: false },
      fromPlanId: { type: DataTypes.UUID, allowNull: true, field: 'from_plan_id' },
      fromBillingCycle: { type: DataTypes.STRING(10), allowNull: false, field: 'from_billing_cycle' },
      toPlanId: { type: DataTypes.UUID, allowNull: true, field: 'to_plan_id' },
      toBillingCycle: { type: DataTypes.STRING(10), allowNull: false, field: 'to_billing_cycle' },
      // The charge an upgrade or a move is paid by (target_plan_id set on it).
      billingInvoiceId: { type: DataTypes.UUID, allowNull: true, field: 'billing_invoice_id' },
      // A scheduled switch: when it takes effect (the end of the paid period).
      effectiveAt: { type: DataTypes.DATE, allowNull: true, field: 'effective_at' },
      appliedAt: { type: DataTypes.DATE, allowNull: true, field: 'applied_at' },
      // When it was cancelled, replaced, expired or dropped, and (dropped) why.
      endedAt: { type: DataTypes.DATE, allowNull: true, field: 'ended_at' },
      endReason: { type: DataTypes.STRING(40), allowNull: true, field: 'end_reason' },
      // What an upgrade was priced on: days left, the two prices, the amount.
      quote: { type: DataTypes.JSONB, allowNull: true },
      requestedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'requested_by_user_id' },
    },
    { tableName: 'plan_switches', underscored: true }
  );
  PlanSwitch.OPEN = ['pending', 'scheduled'];
  PlanSwitch.associate = (models) => {
    PlanSwitch.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', as: 'subscription' });
    PlanSwitch.belongsTo(models.Plan, { foreignKey: 'fromPlanId', as: 'fromPlan' });
    PlanSwitch.belongsTo(models.Plan, { foreignKey: 'toPlanId', as: 'toPlan' });
    PlanSwitch.belongsTo(models.BillingInvoice, { foreignKey: 'billingInvoiceId', as: 'invoice' });
  };
  return PlanSwitch;
};
