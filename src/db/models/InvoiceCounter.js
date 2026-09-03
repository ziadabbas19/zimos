'use strict';

module.exports = (sequelize, DataTypes) => {
  // One row per workspace. Numbers are issued via
  // `UPDATE invoice_counters SET last_number = last_number + 1 WHERE
  // workspace_id = :id RETURNING last_number` inside the invoice-creation
  // transaction — never MAX(invoice_number)+1, which races under concurrency.
  const InvoiceCounter = sequelize.define(
    'InvoiceCounter',
    {
      workspaceId: { type: DataTypes.UUID, primaryKey: true, field: 'workspace_id' },
      lastNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'last_number' },
      prefix: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'INV' },
    },
    { tableName: 'invoice_counters', timestamps: false }
  );
  return InvoiceCounter;
};
