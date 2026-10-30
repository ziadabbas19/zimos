'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * Reviews from anyone, published only by the merchant (modules/reviews).
 *
 * reviews
 *   kind              'product' (on one product, as before) or 'store' (on
 *                     the whole store, product_id NULL). Every row today is a
 *                     product review
 *   product_id        now NULL for a store review only (reviews_kind_check)
 *   show_text         false = the merchant published the stars alone: the
 *                     text and photos stay in the dashboard. Every row today
 *                     keeps true, so what shows today keeps showing
 *   phone_normalized  the phone the reviewer gave (or their order's), for
 *                     "one review per phone": backfilled from the customer of
 *                     every review a shopper sent before
 *   device_id         the storefront's device id, for "one review per device"
 *   request_ip        where it was sent from, for the per-address limit
 *   photo_upload_ids  the reviewer's photos (customer_uploads, private
 *                     storage); `photos` keeps the links a merchant typed in
 *
 * Nothing changes for an existing review: approved ones stay approved and
 * visible, pending ones wait as before. Which reviews count in a rating is
 * decided when it is read (reviews/reviewRating.js), not stored.
 *
 * Run-twice safe: every column, constraint and index is checked first. down
 * refuses while a store review exists (the code before this migration cannot
 * show or hold one); otherwise it removes everything added here.
 */

const PRODUCT_PHONE_INDEX = 'reviews_product_phone_uidx';
const STORE_PHONE_INDEX = 'reviews_store_phone_uidx';
const KIND_STATUS_INDEX = 'reviews_workspace_kind_status_idx';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const q = (sql) => queryInterface.sequelize.query(sql);

    await qi.addColumn('reviews', 'kind', { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'product' });
    await q('ALTER TABLE reviews ALTER COLUMN product_id DROP NOT NULL');
    await qi.addColumn('reviews', 'show_text', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
    await qi.addColumn('reviews', 'phone_normalized', { type: DataTypes.STRING(32), allowNull: true });
    await qi.addColumn('reviews', 'device_id', { type: DataTypes.STRING(128), allowNull: true });
    await qi.addColumn('reviews', 'request_ip', { type: DataTypes.STRING(45), allowNull: true });
    await qi.addColumn('reviews', 'photo_upload_ids', { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] });

    await q('ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_kind_check');
    await q(
      `ALTER TABLE reviews ADD CONSTRAINT reviews_kind_check CHECK (
         kind IN ('product', 'store') AND ((kind = 'product') = (product_id IS NOT NULL))
       )`
    );

    // A shopper's review before this was one per customer, and a customer is one per phone in a store.
    await q(
      `UPDATE reviews r SET phone_normalized = c.phone_normalized
         FROM customers c
        WHERE c.id = r.customer_id AND r.source = 'customer' AND r.phone_normalized IS NULL`
    );

    await createIndexConcurrently(queryInterface, {
      name: PRODUCT_PHONE_INDEX,
      table: 'reviews',
      unique: true,
      definition: "(workspace_id, product_id, phone_normalized) WHERE kind = 'product' AND phone_normalized IS NOT NULL",
    });
    await createIndexConcurrently(queryInterface, {
      name: STORE_PHONE_INDEX,
      table: 'reviews',
      unique: true,
      definition: "(workspace_id, phone_normalized) WHERE kind = 'store' AND phone_normalized IS NOT NULL",
    });
    await createIndexConcurrently(queryInterface, {
      name: KIND_STATUS_INDEX,
      table: 'reviews',
      definition: '(workspace_id, kind, status, created_at)',
    });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    const [[{ present }]] = await queryInterface.sequelize.query(
      "SELECT COUNT(*)::int AS present FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'reviews' AND column_name = 'kind'"
    );
    const [[{ stores }]] = present
      ? await queryInterface.sequelize.query("SELECT COUNT(*)::int AS stores FROM reviews WHERE kind = 'store'")
      : [[{ stores: 0 }]];
    if (stores > 0) {
      throw new Error(
        `729 down: ${stores} store review(s) exist and the code before this migration cannot hold them. Delete them (DELETE FROM reviews WHERE kind = 'store') and run down again.`
      );
    }
    await dropIndexConcurrently(queryInterface, KIND_STATUS_INDEX);
    await dropIndexConcurrently(queryInterface, STORE_PHONE_INDEX);
    await dropIndexConcurrently(queryInterface, PRODUCT_PHONE_INDEX);
    await queryInterface.sequelize.query('ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_kind_check');
    await qi.removeColumn('reviews', 'photo_upload_ids');
    await qi.removeColumn('reviews', 'request_ip');
    await qi.removeColumn('reviews', 'device_id');
    await qi.removeColumn('reviews', 'phone_normalized');
    await qi.removeColumn('reviews', 'show_text');
    await queryInterface.sequelize.query('ALTER TABLE reviews ALTER COLUMN product_id SET NOT NULL');
    await qi.removeColumn('reviews', 'kind');
  },
};
