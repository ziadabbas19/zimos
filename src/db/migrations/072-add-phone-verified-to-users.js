'use strict';

/**
 * Records when a user confirmed their phone number via an SMS code. Also the
 * anchor for password-reset-by-SMS: only a verified phone is looked up.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'phone_verified_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'phone_verified_at');
  },
};
