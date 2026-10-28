'use strict';

module.exports = (sequelize, DataTypes) => {
  // A referral code (migration 106; the rest since migration 725). `discountValue`
  // is basis points for a percentage and minor units of `discountCurrency` for
  // a fixed amount, like the merchant Discount model. Never deleted, only
  // deactivated. `terms` NULL = a code of the first kind (discount_* and
  // commission_rate_bp on every payment); otherwise its schedules
  // (referrals/referralTerms.js) and the discount_* columns are unused.
  const ReferralCode = sequelize.define(
    'ReferralCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      // Null: a discount only, no agent and no commission.
      agentId: { type: DataTypes.UUID, allowNull: true, field: 'agent_id' },
      code: { type: DataTypes.STRING(32), allowNull: false, unique: true },
      label: { type: DataTypes.STRING(120), allowNull: true },
      discountType: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'none', field: 'discount_type' },
      discountValue: { type: DataTypes.BIGINT, allowNull: true, field: 'discount_value' },
      discountCurrency: { type: DataTypes.STRING(3), allowNull: true, field: 'discount_currency' },
      // Null = the platform default (referrals/commissionPolicy.js).
      commissionRateBp: { type: DataTypes.INTEGER, allowNull: true, field: 'commission_rate_bp' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      createdByUserId: { type: DataTypes.UUID, allowNull: true, field: 'created_by_user_id' },
      // Who may enter it: 'new' | 'existing' | 'any' (referrals/redemptionService).
      audience: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'any' },
      startsAt: { type: DataTypes.DATE, allowNull: true, field: 'starts_at' },
      endsAt: { type: DataTypes.DATE, allowNull: true, field: 'ends_at' },
      // Null = no limit. usesCount is raised by the UPDATE that checks the limit.
      maxUses: { type: DataTypes.INTEGER, allowNull: true, field: 'max_uses' },
      usesCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'uses_count' },
      allowedPlanIds: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: true, field: 'allowed_plan_ids' },
      allowedCycles: { type: DataTypes.ARRAY(DataTypes.STRING(10)), allowNull: true, field: 'allowed_cycles' },
      minPriceAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'min_price_amount' },
      minPriceCurrency: { type: DataTypes.STRING(3), allowNull: true, field: 'min_price_currency' },
      terms: { type: DataTypes.JSONB, allowNull: true },
      // 'paid' (what the merchant paid) | 'list' (the price before the discount).
      commissionBasis: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'paid', field: 'commission_basis' },
      // Entering it links a store with no agent yet to this code's agent.
      linksAgent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'links_agent' },
      // A one-time benefit when it is entered: trial_days | wallet_credit | free_orders.
      grantType: { type: DataTypes.STRING(20), allowNull: true, field: 'grant_type' },
      grantValue: { type: DataTypes.BIGINT, allowNull: true, field: 'grant_value' },
      updatedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'updated_by_user_id' },
    },
    { tableName: 'referral_codes' }
  );
  ReferralCode.associate = (models) => {
    ReferralCode.belongsTo(models.User, { foreignKey: 'agentId', as: 'agent' });
    ReferralCode.hasMany(models.Subscription, { foreignKey: 'referralCodeId', as: 'subscriptions' });
    ReferralCode.hasMany(models.ReferralCodeRedemption, { foreignKey: 'codeId', as: 'redemptions' });
  };
  return ReferralCode;
};
