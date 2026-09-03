'use strict';

module.exports = (sequelize, DataTypes) => {
  const Invoice = sequelize.define(
    'Invoice',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      orderId: { type: DataTypes.UUID, allowNull: false, field: 'order_id' },
      invoiceNumber: { type: DataTypes.STRING(40), allowNull: false, field: 'invoice_number' },
      currency: { type: DataTypes.STRING(3), allowNull: false },
      totalAmount: { type: DataTypes.BIGINT, allowNull: false, field: 'total_amount' },
      lineItems: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      issuedAt: { type: DataTypes.DATE, allowNull: false, field: 'issued_at' },
    },
    { tableName: 'invoices', indexes: [{ unique: true, fields: ['workspace_id', 'invoice_number'] }] }
  );
  Invoice.associate = (models) => {
    Invoice.belongsTo(models.Order, { foreignKey: 'orderId', as: 'order' });
    Invoice.hasMany(models.CreditNote, { foreignKey: 'invoiceId', as: 'creditNotes' });
  };
  return Invoice;
};
