'use strict';

/**
 * Archiving a product also archives its variants and offers. Restoring it must
 * bring back only those — not a variant the merchant archived on its own — so
 * the cascade now tags what it took down with archived_with_product.
 *
 * Backfill: products archived before this migration had every variant/offer
 * archived with no record of which were already archived individually. They
 * are all tagged, so restoring such a product revives its whole catalogue
 * (back to draft) instead of leaving it with no sellable variant at all.
 *
 * The order_items(product_id) index serves the "has this product ever been
 * ordered?" check that guards permanent product deletion.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const table of ['product_variants', 'offers']) {
        await queryInterface.addColumn(
          table,
          'archived_with_product',
          { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
          { transaction }
        );
        await queryInterface.sequelize.query(
          `UPDATE ${table} AS child
              SET archived_with_product = true
             FROM products p
            WHERE p.id = child.product_id
              AND p.status = 'archived'
              AND child.status = 'archived';`,
          { transaction }
        );
      }
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS order_items_product_id_idx
           ON order_items (product_id)
           WHERE product_id IS NOT NULL;`,
        { transaction }
      );
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS order_items_product_id_idx;', { transaction });
      await queryInterface.removeColumn('offers', 'archived_with_product', { transaction });
      await queryInterface.removeColumn('product_variants', 'archived_with_product', { transaction });
    });
  },
};
