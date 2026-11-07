'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Rows a person arranges for themselves, as the Home shortcuts of migration 734:
 * an ordered list of catalogue ids, NULL until they arrange it (the default
 * row), [] when they took everything off.
 *
 * memberships.mobile_nav              the phone's bottom bar in the dashboard,
 *   per member and store (dashboard/homeShortcuts.js, MOBILE_NAV)
 * users.console_home_shortcuts        the console Overview's shortcuts row,
 *   per console account (platformAdmin/consoleShortcuts.js)
 * users.console_mobile_nav            the console's bottom bar on a phone, per
 *   console account (same file)
 *
 * The users columns are read and written only by consoleShortcuts (raw SQL,
 * not on the User model), so no other read of a user carries them.
 * Nullable columns with no default: no rewrite, run-twice safe. down drops them.
 */
const COLUMNS = [
  ['memberships', 'mobile_nav'],
  ['users', 'console_home_shortcuts'],
  ['users', 'console_mobile_nav'],
];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    for (const [table, column] of COLUMNS) {
      await qi.addColumn(table, column, { type: Sequelize.DataTypes.JSONB, allowNull: true });
    }
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    for (const [table, column] of [...COLUMNS].reverse()) {
      await qi.removeColumn(table, column);
    }
  },
};
