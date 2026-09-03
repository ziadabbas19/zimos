'use strict';

/**
 * Discounts can now be archived (soft-deleted) instead of only active/disabled.
 * A discount that has already been redeemed is financial history — its
 * discount_redemptions rows are tied to real orders — so DELETE archives it
 * rather than removing the row.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_discounts_status" ADD VALUE IF NOT EXISTS 'archived';`
    );
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      ALTER TABLE "discounts" ALTER COLUMN "status" DROP DEFAULT;
      UPDATE "discounts" SET "status" = 'disabled' WHERE "status" = 'archived';
      ALTER TYPE "enum_discounts_status" RENAME TO "enum_discounts_status_old";
      CREATE TYPE "enum_discounts_status" AS ENUM('active', 'disabled');
      ALTER TABLE "discounts" ALTER COLUMN "status" TYPE "enum_discounts_status"
        USING "status"::text::"enum_discounts_status";
      ALTER TABLE "discounts" ALTER COLUMN "status" SET DEFAULT 'active';
      DROP TYPE "enum_discounts_status_old";
    `);
  },
};
