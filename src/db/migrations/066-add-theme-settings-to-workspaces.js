'use strict';

/**
 * Opaque theme settings blob for the storefront frontend (e.g. templateKey,
 * primaryColor). Stored and returned as-is; the backend never inspects it.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('workspaces', 'theme_settings', {
      type: Sequelize.DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('workspaces', 'theme_settings');
  },
};
