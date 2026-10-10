'use strict';

const { guarded } = require('../migrationGuards');

/**
 * How the dashboard looks for one account (modules/auth/uiPreferences): the
 * look, the tone of the dark one, the glass switch and the glow colours, so
 * they follow the person from one device to another. One JSONB value per
 * user, null until the account saves something. Read and written only by
 * auth/uiPreferencesService (raw SQL, not on the User model), so no other
 * read of a user carries it.
 * A nullable column with no default on users: no rewrite, run-twice safe.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await guarded(queryInterface).addColumn('users', 'ui_preferences', { type: Sequelize.JSONB, allowNull: true });
  },
  down: async (queryInterface) => {
    await guarded(queryInterface).removeColumn('users', 'ui_preferences');
  },
};
