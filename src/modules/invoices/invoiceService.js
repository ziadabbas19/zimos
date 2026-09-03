'use strict';

const db = require('../../db/models');

/**
 * Issues the next invoice number for a workspace using an atomic
 * UPDATE ... RETURNING against invoice_counters, never MAX(invoice_number)+1
 * (which races under concurrency — two simultaneous invoice creations could
 * both read the same MAX and produce a duplicate number). Must be called
 * inside the same transaction as the Invoice row creation.
 */
async function nextInvoiceNumber(workspaceId, transaction) {
  const [counter] = await db.InvoiceCounter.findOrCreate({
    where: { workspaceId },
    defaults: { workspaceId, lastNumber: 0 },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  // findOrCreate with lock doesn't guarantee the row lock on the "found"
  // path in every dialect, so re-fetch explicitly under FOR UPDATE.
  const locked = await db.InvoiceCounter.findOne({
    where: { workspaceId },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });

  const nextNumber = locked.lastNumber + 1;
  await locked.update({ lastNumber: nextNumber }, { transaction });

  return `${locked.prefix}-${String(nextNumber).padStart(6, '0')}`;
}

async function createInvoiceForOrder(order, transaction) {
  const invoiceNumber = await nextInvoiceNumber(order.workspaceId, transaction);
  return db.Invoice.create(
    {
      workspaceId: order.workspaceId,
      orderId: order.id,
      invoiceNumber,
      currency: order.currency,
      totalAmount: order.totalAmount,
      lineItems: (order.items || []).map((i) => ({
        name: i.productNameSnapshot,
        quantity: i.quantity,
        unitPriceAmount: i.unitPriceAmount,
        lineTotalAmount: i.lineTotalAmount,
      })),
      issuedAt: new Date(),
    },
    { transaction }
  );
}

async function creditNoteForRefund(refund, transaction) {
  const invoice = await db.Invoice.findOne({ where: { orderId: refund.orderId }, transaction });
  if (!invoice) return null;

  const counterNumber = await nextInvoiceNumber(refund.workspaceId, transaction); // shares the counter row; prefix differs below
  const creditNoteNumber = counterNumber.replace(invoice.invoiceNumber.split('-')[0], 'CN');

  return db.CreditNote.create(
    {
      workspaceId: refund.workspaceId,
      invoiceId: invoice.id,
      refundId: refund.id,
      creditNoteNumber,
      amount: refund.amount,
      reason: refund.reason,
      issuedAt: new Date(),
    },
    { transaction }
  );
}

module.exports = { nextInvoiceNumber, createInvoiceForOrder, creditNoteForRefund };
