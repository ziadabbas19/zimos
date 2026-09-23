'use strict';

/**
 * A carrier status webhook names a shipment only by the carrier's tracking
 * number, stored as shipments.waybill_number. The webhook finds our row by
 * (workspace, carrier, tracking number); without this index that is a scan of
 * the workspace's shipments on every status push.
 *
 * Partial: manual shipments often have no waybill number at all, and those
 * rows are never looked up this way.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS shipments_carrier_waybill_idx
         ON shipments (workspace_id, carrier_code, waybill_number)
         WHERE waybill_number IS NOT NULL;`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS shipments_carrier_waybill_idx;');
  },
};
