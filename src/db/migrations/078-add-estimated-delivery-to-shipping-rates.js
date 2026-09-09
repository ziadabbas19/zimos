'use strict';

/**
 * Optional delivery-time estimate for a shipping rate, surfaced next to the
 * rate at checkout (e.g. "3–5 days"). Both nullable integers (days). Storage
 * and surfacing only — no effect on the amount
 * shippingPricing.calculateShippingAmount returns.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('shipping_rates', 'estimated_delivery_min_days', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('shipping_rates', 'estimated_delivery_max_days', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('shipping_rates', 'estimated_delivery_max_days');
    await queryInterface.removeColumn('shipping_rates', 'estimated_delivery_min_days');
  },
};
