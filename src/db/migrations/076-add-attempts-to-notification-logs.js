'use strict';

// Records how many provider attempts a notification took (1 when it worked
// first try; up to the retry cap when transient failures were retried).
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('notification_logs', 'attempts', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 1,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('notification_logs', 'attempts');
  },
};
