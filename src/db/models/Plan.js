'use strict';

module.exports = (sequelize, DataTypes) => {
  const Plan = sequelize.define(
    'Plan',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      key: { type: DataTypes.STRING(50), allowNull: false, unique: true },
      name: { type: DataTypes.STRING(150), allowNull: false },
      monthlyPriceAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'monthly_price_amount' },
      yearlyPriceAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'yearly_price_amount' },
      // EGP unless the plan says otherwise (migration 128; it was USD).
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      trialDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 14, field: 'trial_days' },
      // Soft quotas — enforced as warnings/upsell prompts, never as an order-intake blocker.
      softOrderQuota: { type: DataTypes.INTEGER, allowNull: true, field: 'soft_order_quota' },
      // Commission in basis points (1 bp = 0.01%).
      transactionFeeBp: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'transaction_fee_bp' },
      codFeeBp: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'cod_fee_bp' },
      features: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
      // Limits (migration 126), checked when a store or a funnel is created
      // (billing/entitlementsService). NULL = no limit.
      maxStores: { type: DataTypes.INTEGER, allowNull: true, field: 'max_stores' },
      maxFunnelsPerMonth: { type: DataTypes.INTEGER, allowNull: true, field: 'max_funnels_per_month' },
      // Listed on the marketing site and offered at sign-up (GET /plans/public).
      isPublic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_public' },
      displayOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'display_order' },
      // The pay-per-order plan's fee for one order, from the store's prepaid
      // balance (migration 131, billing/walletService). 0 = no fee.
      perOrderFeeAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'per_order_fee_amount' },
      // Orders placed free before any fee is taken (migration 220). 0 = none.
      walletFreeOrders: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'wallet_free_orders' },
      // How far below zero the balance may go, minor units. null = the fixed
      // overdraft and the old refusal (walletService).
      walletDebtLimitAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'wallet_debt_limit_amount' },
      // Email campaigns one store may send a month, Cairo time (migration 748,
      // emailCampaigns/campaignQuota). null = unlimited; 0 (what existing plans got) = none.
      maxCampaignEmailsPerMonth: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0, field: 'max_campaign_emails_per_month' },
    },
    { tableName: 'plans' }
  );
  return Plan;
};
