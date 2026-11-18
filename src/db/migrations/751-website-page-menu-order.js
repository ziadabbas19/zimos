'use strict';

const TABLE = 'website_pages';
const COLUMN = 'menu_order';

/** The merchant's own order of the pages in the store's menus. Empty keeps today's order. */
module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable(TABLE);
    if (!columns[COLUMN]) await queryInterface.addColumn(TABLE, COLUMN, { type: Sequelize.INTEGER, allowNull: true });
  },

  async down(queryInterface) {
    const columns = await queryInterface.describeTable(TABLE);
    if (columns[COLUMN]) await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
