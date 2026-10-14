'use strict';

/**
 * Any pending subscription charge can be voided, not only a move's
 * (PLAN_SWITCH_ENABLED): by the merchant (POST /billing/charges/:id/cancel),
 * by the console with a reason (POST /admin/charges/:id/void), or when a
 * plan switch's payment fails. Additive only.
 *
 * billing_invoices.void_reason
 *   widened to VARCHAR(40) (no table rewrite) and three more reasons:
 *   cancelled_by_merchant, voided_by_admin, payment_failed. The CHECK is
 *   added NOT VALID and validated after, so the table isn't held while it is
 *   checked.
 *
 * billing_invoices.void_note
 *   the console's reason for voiding a charge, shown with it. NULL otherwise.
 *
 * Harmless if it runs again. Down: the new reasons become 'cancelled' (the
 * nearest old one), the note goes, the old check and width come back.
 */

const REASONS = ['cancelled', 'replaced', 'expired', 'cancelled_by_merchant', 'voided_by_admin', 'payment_failed'];
const OLD_REASONS = ['cancelled', 'replaced', 'expired'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run('ALTER TABLE billing_invoices ALTER COLUMN void_reason TYPE VARCHAR(40)');
      await run('ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS void_note VARCHAR(500)');
      await run('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_void_reason_check');
      await run(
        `ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_void_reason_check CHECK (void_reason IS NULL OR void_reason IN (${list(REASONS)})) NOT VALID`
      );
      await run('ALTER TABLE billing_invoices VALIDATE CONSTRAINT billing_invoices_void_reason_check');
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`UPDATE billing_invoices SET void_reason = 'cancelled', updated_at = NOW() WHERE void_reason IS NOT NULL AND void_reason NOT IN (${list(OLD_REASONS)})`);
      await run('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_void_reason_check');
      await run(`ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_void_reason_check CHECK (void_reason IS NULL OR void_reason IN (${list(OLD_REASONS)}))`);
      await run('ALTER TABLE billing_invoices DROP COLUMN IF EXISTS void_note');
      await run('ALTER TABLE billing_invoices ALTER COLUMN void_reason TYPE VARCHAR(20)');
    });
  },
};
