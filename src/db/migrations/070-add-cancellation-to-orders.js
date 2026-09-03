'use strict';

/**
 * A merchant can now cancel an order directly (not only via a COD rejection).
 * `cancelled_at` is the marker that distinguishes a merchant cancellation
 * from a confirmation rejection (both land on confirmation_state 'rejected'),
 * and `cancellation_reason` records why.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('orders', 'cancelled_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('orders', 'cancellation_reason', {
      type: Sequelize.STRING(500),
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('orders', 'cancellation_reason');
    await queryInterface.removeColumn('orders', 'cancelled_at');
  },
};
