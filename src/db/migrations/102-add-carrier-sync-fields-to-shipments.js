'use strict';

/**
 * Carrier-agnostic bookkeeping on shipments.
 *
 *   carrier_account_id      the merchant's carrier account a shipment was
 *                           booked through. Backfilled for every existing
 *                           carrier-booked shipment (a waybill number and a
 *                           carrierShipmentId in carrier_response) from the
 *                           one account per (workspace, carrier). NULL for
 *                           manual shipments, and once the account is
 *                           disconnected (ON DELETE SET NULL).
 *   cancel_mode             how a carrier-booked shipment was cancelled:
 *                           'api' (the carrier's cancel call succeeded or
 *                           the carrier already had it cancelled),
 *                           'manual_ack' (the carrier has no cancel API; the
 *                           merchant cancelled it in the carrier's dashboard
 *                           and said so). NULL otherwise.
 *   cancel_acknowledged_by  the user who made that statement, and when
 *   cancel_acknowledged_at
 *   next_poll_at            when scripts/sync-carrier-shipments.js next reads
 *                           the shipment from the carrier. NULL: never (no
 *                           existing row is scheduled — Bosta is not polled)
 *   last_polled_at          the last successful read by that script
 *   poll_failures           consecutive failed reads (drives the backoff)
 */
const CHECK = 'shipments_cancel_mode_check';
const DUE_INDEX = 'shipments_next_poll_at_due_idx';
const ACCOUNT_INDEX = 'shipments_carrier_account_id_idx';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      const add = (column, spec) => queryInterface.addColumn('shipments', column, spec, { transaction });

      await add('carrier_account_id', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'carrier_accounts', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
      await add('cancel_mode', { type: DataTypes.STRING(20), allowNull: true });
      await add('cancel_acknowledged_by', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
      await add('cancel_acknowledged_at', { type: DataTypes.DATE, allowNull: true });
      await add('next_poll_at', { type: DataTypes.DATE, allowNull: true });
      await add('last_polled_at', { type: DataTypes.DATE, allowNull: true });
      await add('poll_failures', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });

      await queryInterface.sequelize.query(
        `ALTER TABLE shipments ADD CONSTRAINT ${CHECK} CHECK (cancel_mode IS NULL OR cancel_mode IN ('api', 'manual_ack'))`,
        { transaction }
      );
      // The sync script's "what is due" scan; only scheduled rows are indexed.
      await queryInterface.sequelize.query(
        `CREATE INDEX ${DUE_INDEX} ON shipments (next_poll_at) WHERE next_poll_at IS NOT NULL`,
        { transaction }
      );
      await queryInterface.addIndex('shipments', ['carrier_account_id'], { name: ACCOUNT_INDEX, transaction });

      await queryInterface.sequelize.query(
        `UPDATE shipments s
            SET carrier_account_id = ca.id
           FROM carrier_accounts ca
          WHERE s.carrier_account_id IS NULL
            AND ca.workspace_id = s.workspace_id
            AND ca.carrier_code = s.carrier_code
            AND s.waybill_number IS NOT NULL
            AND s.carrier_response ? 'carrierShipmentId'`,
        { transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex('shipments', ACCOUNT_INDEX, { transaction });
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ${DUE_INDEX}`, { transaction });
      await queryInterface.sequelize.query(`ALTER TABLE shipments DROP CONSTRAINT IF EXISTS ${CHECK}`, { transaction });
      for (const column of [
        'poll_failures',
        'last_polled_at',
        'next_poll_at',
        'cancel_acknowledged_at',
        'cancel_acknowledged_by',
        'cancel_mode',
        'carrier_account_id',
      ]) {
        // eslint-disable-next-line no-await-in-loop
        await queryInterface.removeColumn('shipments', column, { transaction });
      }
    });
  },
};
