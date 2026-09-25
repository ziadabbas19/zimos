'use strict';

/**
 * Two-step refunds and the order-completed stamp.
 *
 * refunds:
 * - source: who started it — 'merchant' (the dashboard) or 'gateway' (issued
 *   in the gateway's own dashboard and reported to us by webhook). VARCHAR
 *   with a CHECK rather than an enum, so a later value is a plain constraint
 *   swap instead of ALTER TYPE ... ADD VALUE.
 * - provider_refund_reference: the gateway's id for the refund. Unique per
 *   payment, so a refund reported twice (our own call's answer and then its
 *   webhook, or a webhook redelivered) is recorded once.
 * - failure_reason, processed_at: the outcome of the provider call, which now
 *   happens after the refund row is committed as 'pending'.
 *
 * orders.completed_at: when the order became a sale (invoice, discount
 * redemption, customer.totalOrders — see orders/orderCompletion.js). Every
 * existing order went through all three at creation, so it is backfilled from
 * created_at.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'refunds',
        'source',
        { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'merchant' },
        { transaction }
      );
      await queryInterface.sequelize.query(
        "ALTER TABLE refunds ADD CONSTRAINT refunds_source_check CHECK (source IN ('merchant', 'gateway'));",
        { transaction }
      );
      await queryInterface.addColumn(
        'refunds',
        'provider_refund_reference',
        { type: Sequelize.STRING(200), allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn('refunds', 'failure_reason', { type: Sequelize.STRING(300), allowNull: true }, { transaction });
      await queryInterface.addColumn('refunds', 'processed_at', { type: Sequelize.DATE, allowNull: true }, { transaction });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS refunds_payment_provider_reference_uniq
           ON refunds (payment_id, provider_refund_reference)
        WHERE provider_refund_reference IS NOT NULL;`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        "UPDATE refunds SET processed_at = updated_at WHERE status = 'processed';",
        { transaction }
      );

      await queryInterface.addColumn('orders', 'completed_at', { type: Sequelize.DATE, allowNull: true }, { transaction });
      await queryInterface.sequelize.query('UPDATE orders SET completed_at = created_at;', { transaction });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('orders', 'completed_at', { transaction });
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS refunds_payment_provider_reference_uniq;', { transaction });
      await queryInterface.removeColumn('refunds', 'processed_at', { transaction });
      await queryInterface.removeColumn('refunds', 'failure_reason', { transaction });
      await queryInterface.removeColumn('refunds', 'provider_refund_reference', { transaction });
      await queryInterface.sequelize.query('ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_source_check;', { transaction });
      await queryInterface.removeColumn('refunds', 'source', { transaction });
    });
  },
};
