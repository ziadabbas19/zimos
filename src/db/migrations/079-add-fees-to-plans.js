'use strict';

/**
 * Per-plan commission, in basis points (1 bp = 0.01%). The platform-admin plan
 * editor exposes both: `transaction_fee_bp` is taken on every paid order,
 * `cod_fee_bp` is the extra cut on cash-on-delivery. Stored as integers so the
 * arithmetic never goes through a float.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('plans', 'transaction_fee_bp', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('plans', 'cod_fee_bp', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('plans', 'cod_fee_bp');
    await queryInterface.removeColumn('plans', 'transaction_fee_bp');
  },
};
