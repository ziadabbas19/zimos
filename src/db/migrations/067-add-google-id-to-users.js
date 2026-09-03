'use strict';

/**
 * Google OAuth login. `google_id` is Google's `sub` claim, nullable + unique.
 * `password_hash` is relaxed to nullable so a Google-only account can exist
 * with no password. Existing email/password users are unaffected.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('users', 'google_id', {
      type: Sequelize.DataTypes.STRING(64),
      allowNull: true,
    });
    await queryInterface.addIndex('users', ['google_id'], {
      unique: true,
      name: 'users_google_id_idx',
    });
    await queryInterface.sequelize.query('ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;');
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL;');
    await queryInterface.removeIndex('users', 'users_google_id_idx');
    await queryInterface.removeColumn('users', 'google_id');
  },
};
