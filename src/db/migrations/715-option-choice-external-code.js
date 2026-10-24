'use strict';

const { guarded } = require('../migrationGuards');

/**
 * product_option_choices.external_code: the code a menu choice ("Extra
 * cheese") has in the merchant's own till or kitchen system, sent with the
 * order's options to webhooks and the public API
 * (ORDER_PAYLOAD_OPTIONS_ENABLED, publicApi/publicOrderOptions.js) so the
 * receiving system can match the modifier. Never shown to shoppers.
 *
 * Nullable, no default: no rewrite of the table. Run-twice safe; down drops
 * the column (the codes typed into it go with it).
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('product_option_choices', 'external_code', { type: Sequelize.STRING(120), allowNull: true });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.removeColumn('product_option_choices', 'external_code');
  },
};
