'use strict';

module.exports = (sequelize, DataTypes) => {
  // Refunds create credit notes; the original invoice is never mutated —
  // historical invoices are immutable financial records.
  const CreditNote = sequelize.define(
    'CreditNote',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      invoiceId: { type: DataTypes.UUID, allowNull: false, field: 'invoice_id' },
      refundId: { type: DataTypes.UUID, allowNull: true, field: 'refund_id' },
      creditNoteNumber: { type: DataTypes.STRING(40), allowNull: false, field: 'credit_note_number' },
      amount: { type: DataTypes.BIGINT, allowNull: false },
      reason: { type: DataTypes.STRING(300), allowNull: true },
      issuedAt: { type: DataTypes.DATE, allowNull: false, field: 'issued_at' },
    },
    { tableName: 'credit_notes', indexes: [{ unique: true, fields: ['workspace_id', 'credit_note_number'] }] }
  );
  CreditNote.associate = (models) => {
    CreditNote.belongsTo(models.Invoice, { foreignKey: 'invoiceId', as: 'invoice' });
  };
  return CreditNote;
};
