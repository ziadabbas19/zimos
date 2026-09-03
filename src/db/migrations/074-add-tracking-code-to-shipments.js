'use strict';

/**
 * Every shipment gets a human-facing tracking code — `zg` + 9 digits — that
 * is distinct from the UUID primary key. It's what shows on the waybill,
 * shipment responses and anywhere a person reads a shipment. Uniqueness is
 * enforced by a unique index; the app generates with a collision-retry loop.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('shipments', 'tracking_code', {
      type: Sequelize.STRING(16),
      allowNull: true,
    });

    // Backfill any existing rows with a unique random code.
    await queryInterface.sequelize.query(`
      UPDATE "shipments"
      SET "tracking_code" = 'zg' || lpad((floor(random() * 1000000000))::bigint::text, 9, '0')
      WHERE "tracking_code" IS NULL;
    `);

    await queryInterface.addIndex('shipments', ['tracking_code'], {
      unique: true,
      name: 'shipments_tracking_code_uidx',
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "shipments" ALTER COLUMN "tracking_code" SET NOT NULL;`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('shipments', 'shipments_tracking_code_uidx');
    await queryInterface.removeColumn('shipments', 'tracking_code');
  },
};
