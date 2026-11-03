'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The Home page's shortcuts row, as this member arranged it: an ordered list
 * of ids from the catalogue in modules/dashboard/homeShortcuts.js. Per
 * membership, so each person has their own row in each store. NULL means the
 * member never arranged it and gets the default row; [] means they took
 * everything off it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.addColumn('memberships', 'home_shortcuts', {
      type: Sequelize.DataTypes.JSONB,
      allowNull: true,
    });
  },
  down: async (queryInterface) => {
    queryInterface = guarded(queryInterface);
    await queryInterface.removeColumn('memberships', 'home_shortcuts');
  },
};
