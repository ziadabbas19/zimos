'use strict';

/**
 * When a customer was put on the blocklist, for GET /fraud/blocklist's
 * newest-first ordering and its `blockedAt`.
 *
 * Backfill: rows already blacklisted get their updated_at. That is the best
 * the table knows — it is the time of the customer's last write, which for a
 * blacklisted customer is usually the blacklisting itself, but can be later
 * (a contact edit, a counter bump from a confirmation outcome). Close enough
 * to order the list; not an audit record. audit_logs holds the exact moment
 * for anyone who needs it.
 *
 * No index: the list filters on (workspace_id, is_blacklisted), which
 * customers_workspace_id_is_blacklisted already serves, and sorts the
 * handful of blacklisted rows that come back.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'customers',
        'blacklisted_at',
        { type: Sequelize.DATE, allowNull: true },
        { transaction }
      );
      await queryInterface.sequelize.query(
        'UPDATE customers SET blacklisted_at = updated_at WHERE is_blacklisted = true',
        { transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('customers', 'blacklisted_at');
  },
};
