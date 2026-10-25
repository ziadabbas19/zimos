'use strict';

const { guarded } = require('../migrationGuards');
const { withLockTimeout } = require('../lockTimeout');

/**
 * product_option_choices.external_code: the code a menu choice ("Extra
 * cheese") has in the merchant's own till or kitchen system, sent with the
 * order's options to webhooks and the public API
 * (ORDER_PAYLOAD_OPTIONS_ENABLED, publicApi/publicOrderOptions.js) so the
 * receiving system can match the modifier. Never shown to shoppers.
 *
 * Nullable, no default: no rewrite of the table. The brief lock it takes on
 * a table every product page reads is asked for under a lock_timeout with
 * retries (db/lockTimeout.js), never waited for behind a long transaction.
 * Run-twice safe; down drops the column (the codes typed into it go with
 * it).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await withLockTimeout(queryInterface.sequelize, (transaction) =>
      qi.addColumn('product_option_choices', 'external_code', { type: Sequelize.STRING(120), allowNull: true }, { transaction })
    );
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await withLockTimeout(queryInterface.sequelize, (transaction) => qi.removeColumn('product_option_choices', 'external_code', { transaction }));
  },
};
