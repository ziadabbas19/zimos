'use strict';

/**
 * Lets a merchant deactivate a shipping zone or an individual rate without
 * deleting it. shippingPricing.calculateShippingAmount skips inactive zones
 * and inactive rates when pricing the shipping line at checkout; the admin
 * CRUD keeps listing them so they can be toggled back on.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('shipping_zones', 'is_active', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
    await queryInterface.addColumn('shipping_rates', 'is_active', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('shipping_rates', 'is_active');
    await queryInterface.removeColumn('shipping_zones', 'is_active');
  },
};
