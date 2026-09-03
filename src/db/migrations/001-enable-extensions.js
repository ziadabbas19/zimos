'use strict';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS citext;');
  },
  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP EXTENSION IF EXISTS citext;');
  },
};
