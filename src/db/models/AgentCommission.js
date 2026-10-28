'use strict';

module.exports = (sequelize, DataTypes) => {
  // One commission ledger row per paid billing invoice of a store linked to
  // an agent (migration 106; since migration 725 the link, agent_links, says
  // which agent and at what rate: from a code, or set by hand with no code). Informational only: the one write after creation is
  // a person flipping payoutStatus to marked_paid.
  const AgentCommission = sequelize.define(
    'AgentCommission',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      agentId: { type: DataTypes.UUID, allowNull: false, field: 'agent_id' },
      // Null for a link set by hand (migration 725).
      codeId: { type: DataTypes.UUID, allowNull: true, field: 'code_id' },
      agentLinkId: { type: DataTypes.UUID, allowNull: true, field: 'agent_link_id' },
      // Which payment of the link this was (1 = the first), the basis the
      // rate was applied to ('paid' | 'list') and that amount (migration 725).
      paymentNo: { type: DataTypes.INTEGER, allowNull: true, field: 'payment_no' },
      commissionBasis: { type: DataTypes.STRING(10), allowNull: true, field: 'commission_basis' },
      baseAmount: { type: DataTypes.BIGINT, allowNull: true, field: 'base_amount' },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // One LIVE row per invoice (partial unique index, migration 108): a
      // reversed payment voids its row, and paying again writes a new one.
      billingInvoiceId: { type: DataTypes.UUID, allowNull: false, field: 'billing_invoice_id' },
      amountPaid: { type: DataTypes.BIGINT, allowNull: false, field: 'amount_paid' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      paidAt: { type: DataTypes.DATE, allowNull: false, field: 'paid_at' },
      // The rate used for suggestedCommission, kept so a later rate change
      // never rewrites history.
      commissionRateBp: { type: DataTypes.INTEGER, allowNull: false, field: 'commission_rate_bp' },
      suggestedCommission: { type: DataTypes.BIGINT, allowNull: false, field: 'suggested_commission' },
      // True for the subscription's first paid charge, false for a renewal.
      isFirstPayment: { type: DataTypes.BOOLEAN, allowNull: false, field: 'is_first_payment' },
      payoutStatus: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending', field: 'payout_status' },
      payoutNote: { type: DataTypes.TEXT, allowNull: true, field: 'payout_note' },
      markedPaidByAdminId: { type: DataTypes.UUID, allowNull: true, field: 'marked_paid_by_admin_id' },
      markedPaidAt: { type: DataTypes.DATE, allowNull: true, field: 'marked_paid_at' },
      // Set when the payment behind the row was reversed (migration 108). A
      // voided row is kept, not deleted, and never counts in totals; its
      // payoutStatus is left as it was, so a row already paid out stays
      // visible as money to recover.
      voidedAt: { type: DataTypes.DATE, allowNull: true, field: 'voided_at' },
      voidedByAdminId: { type: DataTypes.UUID, allowNull: true, field: 'voided_by_admin_id' },
      voidReason: { type: DataTypes.TEXT, allowNull: true, field: 'void_reason' },
    },
    { tableName: 'agent_commissions' }
  );
  AgentCommission.associate = (models) => {
    AgentCommission.belongsTo(models.User, { foreignKey: 'agentId', as: 'agent' });
    AgentCommission.belongsTo(models.ReferralCode, { foreignKey: 'codeId', as: 'code' });
    AgentCommission.belongsTo(models.AgentLink, { foreignKey: 'agentLinkId', as: 'link' });
    AgentCommission.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    AgentCommission.belongsTo(models.BillingInvoice, { foreignKey: 'billingInvoiceId', as: 'invoice' });
    AgentCommission.belongsTo(models.User, { foreignKey: 'markedPaidByAdminId', as: 'markedPaidBy' });
    AgentCommission.belongsTo(models.User, { foreignKey: 'voidedByAdminId', as: 'voidedBy' });
  };
  return AgentCommission;
};
