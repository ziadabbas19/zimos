'use strict';

/**
 * Store branding: a logo URL + a short tagline. Both nullable.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.addColumn('workspaces', 'logo_url', { type: DataTypes.STRING(1000), allowNull: true });
    await queryInterface.addColumn('workspaces', 'tagline', { type: DataTypes.STRING(300), allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('workspaces', 'tagline');
    await queryInterface.removeColumn('workspaces', 'logo_url');
  },
};
