'use strict';

/**
 * Two more payment-attempt statuses:
 *   expired    the order's payment window closed before the shopper paid
 *   cancelled  replaced by a retry, or the shopper switched to cash on delivery
 *
 * ALTER TYPE ... ADD VALUE is deliberately alone in this file and NOT wrapped
 * in a transaction: before PostgreSQL 12 it cannot run inside a transaction
 * block at all, and from 12 on a value added in a transaction cannot be used
 * until that transaction commits. sequelize-cli runs each migration file
 * without a wrapping transaction, so this works on either. IF NOT EXISTS
 * makes a re-run harmless.
 *
 * The down migration leaves the values in place: removing an enum value means
 * rebuilding the type, and rows may already hold them.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_payments_status" ADD VALUE IF NOT EXISTS 'expired';`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_payments_status" ADD VALUE IF NOT EXISTS 'cancelled';`);
  },

  down: async () => {},
};
