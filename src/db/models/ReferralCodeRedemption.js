'use strict';

module.exports = (sequelize, DataTypes) => {
  // A store entering a referral code (migration 725, referrals/redemptionService).
  // Never deleted. `terms` / `commissionBasis` / `grant*` are the code's as
  // they stood when it was entered; null terms (rows backfilled from before
  // migration 725, source 'legacy') = the code as it stands at each payment.
  const ReferralCodeRedemption = sequelize.define(
    'ReferralCodeRedemption',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      codeId: { type: DataTypes.UUID, allowNull: false, field: 'code_id' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
      // The store's owner (the merchant account the once-per-account rule is on) and who typed it.
      ownerUserId: { type: DataTypes.UUID, allowNull: true, field: 'owner_user_id' },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
      // The owner's email as referrals/emailKey.js normalizes it.
      emailKey: { type: DataTypes.STRING(320), allowNull: true, field: 'email_key' },
      // The code's agent when it was entered.
      agentId: { type: DataTypes.UUID, allowNull: true, field: 'agent_id' },
      // signup | plan_page | plan_switch | legacy
      source: { type: DataTypes.STRING(20), allowNull: false },
      // 'new' | 'existing' when it was entered (redemptionService.merchantKind); null for legacy.
      merchantKind: { type: DataTypes.STRING(10), allowNull: true, field: 'merchant_kind' },
      // The first code this store ever entered; set once, never moved.
      isFirst: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_first' },
      // Written with REFERRAL_CODES_V2_ENABLED on: once per account and email (unique indexes).
      singleUse: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'single_use' },
      billingCycle: { type: DataTypes.STRING(10), allowNull: true, field: 'billing_cycle' },
      terms: { type: DataTypes.JSONB, allowNull: true },
      commissionBasis: { type: DataTypes.STRING(10), allowNull: true, field: 'commission_basis' },
      grantType: { type: DataTypes.STRING(20), allowNull: true, field: 'grant_type' },
      grantValue: { type: DataTypes.BIGINT, allowNull: true, field: 'grant_value' },
      grantAppliedAt: { type: DataTypes.DATE, allowNull: true, field: 'grant_applied_at' },
      // The first payment it was applied to.
      firstInvoiceId: { type: DataTypes.UUID, allowNull: true, field: 'first_invoice_id' },
      // Set when another code took its place ('replaced'); one row per store has none.
      endedAt: { type: DataTypes.DATE, allowNull: true, field: 'ended_at' },
      endReason: { type: DataTypes.STRING(20), allowNull: true, field: 'end_reason' },
    },
    { tableName: 'referral_code_redemptions' }
  );
  ReferralCodeRedemption.associate = (models) => {
    ReferralCodeRedemption.belongsTo(models.ReferralCode, { foreignKey: 'codeId', as: 'code' });
    ReferralCodeRedemption.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    ReferralCodeRedemption.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', as: 'subscription' });
    ReferralCodeRedemption.belongsTo(models.User, { foreignKey: 'ownerUserId', as: 'owner' });
    ReferralCodeRedemption.belongsTo(models.User, { foreignKey: 'agentId', as: 'agent' });
    ReferralCodeRedemption.belongsTo(models.BillingInvoice, { foreignKey: 'firstInvoiceId', as: 'firstInvoice' });
  };
  return ReferralCodeRedemption;
};
