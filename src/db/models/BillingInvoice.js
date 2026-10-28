'use strict';

module.exports = (sequelize, DataTypes) => {
  // Platform SaaS billing invoices — distinct from merchant-facing Invoice
  // (which bills the merchant's own customers). One row per subscription
  // charge; see billing/subscriptionChargeService.
  const BillingInvoice = sequelize.define(
    'BillingInvoice',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      subscriptionId: { type: DataTypes.UUID, allowNull: false, field: 'subscription_id' },
      // What is due: grossAmount - discountAmount. Re-priced when the charge is
      // paid, because the referral code is judged at payment time.
      amount: { type: DataTypes.BIGINT, allowNull: false },
      // What was actually received (migration 107). Set when paid; differs
      // from `amount` when a payment recorded by hand was short or over.
      amountPaid: { type: DataTypes.BIGINT, allowNull: true, field: 'amount_paid' },
      paymentNote: { type: DataTypes.TEXT, allowNull: true, field: 'payment_note' },
      // The platform user who recorded the payment by hand; null when it came
      // from the gateway webhook.
      recordedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'recorded_by_user_id' },
      // 'gateway' | 'manual', set when paid (migration 108). Only a manual
      // payment can be reversed.
      paymentSource: { type: DataTypes.STRING(10), allowNull: true, field: 'payment_source' },
      // When a manual payment was recorded; paidAt is when the money arrived,
      // which may be earlier.
      paymentRecordedAt: { type: DataTypes.DATE, allowNull: true, field: 'payment_recorded_at' },
      // The subscription's { status, currentPeriodStart, currentPeriodEnd }
      // just before this payment changed them (migration 109). A reversal
      // uses it to tell whether the payment is what made the subscription
      // active.
      subscriptionBeforePayment: { type: DataTypes.JSONB, allowNull: true, field: 'subscription_before_payment' },
      // The special-terms price override this charge was priced with, if any
      // (migration 112).
      specialTermsId: { type: DataTypes.UUID, allowNull: true, field: 'special_terms_id' },
      // The plan price for the period, before any referral discount.
      grossAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'gross_amount' },
      discountAmount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0, field: 'discount_amount' },
      // The referral code this charge was priced with, or null. Re-checked
      // when the charge is paid: a code no longer active is removed then, so
      // a PAID invoice with a code is one the code was active for, and it has
      // a commission row.
      referralCodeId: { type: DataTypes.UUID, allowNull: true, field: 'referral_code_id' },
      // The store's use of that code (migration 725) and which payment of it
      // this was (1 = the first paid with it), set when it is paid; the
      // code's schedule priced it by that number.
      referralRedemptionId: { type: DataTypes.UUID, allowNull: true, field: 'referral_redemption_id' },
      referralPaymentNo: { type: DataTypes.INTEGER, allowNull: true, field: 'referral_payment_no' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      // 'void': a charge that no longer asks for money (migration 224; any
      // pending charge since migration 703).
      status: { type: DataTypes.ENUM('pending', 'paid', 'failed', 'void'), allowNull: false, defaultValue: 'pending' },
      voidedAt: { type: DataTypes.DATE, allowNull: true, field: 'voided_at' },
      // cancelled (a move cancelled) | replaced (by another move or switch) |
      // expired (unpaid in time) | cancelled_by_merchant | voided_by_admin |
      // payment_failed (a plan switch's payment that didn't go through).
      voidReason: { type: DataTypes.STRING(40), allowNull: true, field: 'void_reason' },
      // The console's reason when it voided the charge (migration 703).
      voidNote: { type: DataTypes.STRING(500), allowNull: true, field: 'void_note' },
      // A pay-per-order store's move (migration 222): the plan and cycle it
      // switches to when this charge is paid. null on every other charge.
      targetPlanId: { type: DataTypes.UUID, allowNull: true, field: 'target_plan_id' },
      targetBillingCycle: { type: DataTypes.STRING(10), allowNull: true, field: 'target_billing_cycle' },
      periodStart: { type: DataTypes.DATE, allowNull: false, field: 'period_start' },
      periodEnd: { type: DataTypes.DATE, allowNull: false, field: 'period_end' },
      paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
      failureReason: { type: DataTypes.STRING(300), allowNull: true, field: 'failure_reason' },
      // The gateway's id for the payment, once one is wired in.
      externalReference: { type: DataTypes.STRING(200), allowNull: true, field: 'external_reference' },
    },
    {
      tableName: 'billing_invoices',
      indexes: [{ fields: ['workspace_id'] }, { fields: ['subscription_id'] }],
      hooks: {
        // An invoice written without a discount breakdown (anything created
        // before migration 106's columns, or outside the charge service) is
        // its own gross amount: amount = gross - 0.
        beforeValidate(invoice) {
          if (invoice.grossAmount == null && invoice.amount != null) {
            invoice.grossAmount = Number(invoice.amount) + Number(invoice.discountAmount || 0);
          }
          // Likewise a paid invoice written without what was received was
          // paid in full.
          if (invoice.status === 'paid' && invoice.amountPaid == null && invoice.amount != null) {
            invoice.amountPaid = Number(invoice.amount);
          }
        },
      },
    }
  );
  BillingInvoice.associate = (models) => {
    BillingInvoice.belongsTo(models.Subscription, { foreignKey: 'subscriptionId', as: 'subscription' });
    BillingInvoice.belongsTo(models.ReferralCode, { foreignKey: 'referralCodeId', as: 'referralCode' });
    BillingInvoice.belongsTo(models.ReferralCodeRedemption, { foreignKey: 'referralRedemptionId', as: 'referralRedemption' });
    BillingInvoice.belongsTo(models.User, { foreignKey: 'recordedByUserId', as: 'recordedBy' });
    BillingInvoice.belongsTo(models.SubscriptionTerm, { foreignKey: 'specialTermsId', as: 'specialTerms' });
    // Checkouts started for this charge (migration 129).
    BillingInvoice.hasMany(models.BillingPaymentAttempt, { foreignKey: 'billingInvoiceId', as: 'onlinePayments' });
    // The live ledger row; a reversed payment leaves a voided one behind.
    BillingInvoice.hasOne(models.AgentCommission, {
      foreignKey: 'billingInvoiceId',
      as: 'commission',
      scope: { voidedAt: null },
    });
  };
  return BillingInvoice;
};
