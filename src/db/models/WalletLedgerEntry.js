'use strict';

module.exports = (sequelize, DataTypes) => {
  // One change to a store's balance (migration 131). Append-only: the table
  // refuses UPDATE and DELETE. The idempotency key makes an event move money
  // once. order_id and payment_proof_id are references without a foreign key.
  const WalletLedgerEntry = sequelize.define(
    'WalletLedgerEntry',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // topup | order_fee | order_fee_reversal | order_fee_recharge |
      // order_confirm_fee (once per order, migration 718) | …
      entryType: { type: DataTypes.STRING(30), allowNull: false, field: 'entry_type' },
      cashDelta: { type: DataTypes.BIGINT, allowNull: false, field: 'cash_delta' },
      // Free orders taken (-1), given back (+1) or granted (+n) (migration 220).
      freeOrdersDelta: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'free_orders_delta' },
      // A refund_hold / refund_release / refund_paid entry's request (migration 223).
      refundRequestId: { type: DataTypes.UUID, allowNull: true, field: 'refund_request_id' },
      balanceAfter: { type: DataTypes.BIGINT, allowNull: false, field: 'balance_after' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      orderId: { type: DataTypes.UUID, allowNull: true, field: 'order_id' },
      paymentProofId: { type: DataTypes.UUID, allowNull: true, field: 'payment_proof_id' },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
      note: { type: DataTypes.STRING(500), allowNull: true },
      idempotencyKey: { type: DataTypes.STRING(120), allowNull: false, unique: true, field: 'idempotency_key' },
    },
    { tableName: 'wallet_ledger_entries', updatedAt: false }
  );
  WalletLedgerEntry.TYPES = ['topup', 'order_fee', 'order_fee_reversal', 'order_fee_recharge'];
  return WalletLedgerEntry;
};
