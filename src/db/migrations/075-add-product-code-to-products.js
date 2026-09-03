'use strict';

/**
 * Every product gets a distinct 9-digit product_code, separate from the UUID
 * primary key and from the ORD-.../zg... patterns used elsewhere. The app
 * assigns it on create with a collision-retry loop; uniqueness is enforced
 * by the index below.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('products', 'product_code', {
      type: Sequelize.STRING(9),
      allowNull: true,
    });

    // Backfill every existing row with a unique 9-digit code before the
    // NOT NULL + unique constraint go on. A single random base (constant for
    // this run) plus row_number keeps them unique and 9 digits wide.
    await queryInterface.sequelize.query(`
      WITH base AS (
        SELECT (floor(random() * 100000000))::bigint AS b
      ),
      numbered AS (
        SELECT p.id,
               (SELECT b FROM base) + row_number() OVER (ORDER BY p.created_at, p.id) AS num
        FROM products p
        WHERE p.product_code IS NULL
      )
      UPDATE products p
      SET product_code = lpad(numbered.num::text, 9, '0')
      FROM numbered
      WHERE p.id = numbered.id;
    `);

    await queryInterface.addIndex('products', ['product_code'], {
      unique: true,
      name: 'products_product_code_uidx',
    });
    await queryInterface.sequelize.query(
      `ALTER TABLE "products" ALTER COLUMN "product_code" SET NOT NULL;`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeIndex('products', 'products_product_code_uidx');
    await queryInterface.removeColumn('products', 'product_code');
  },
};
