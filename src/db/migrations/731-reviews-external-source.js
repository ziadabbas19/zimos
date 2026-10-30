'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Reviews the merchant brings from another site (modules/reviews/manualReviews.js):
 * a review written on Facebook, Google, Instagram, WhatsApp or elsewhere,
 * typed in by the merchant with where it came from. Stored with source
 * 'external'. Like every review without a delivered order, it never counts in
 * the stars (reviews/reviewRating.js), and the storefront shows it apart,
 * with its source and without the verified-buyer mark.
 *
 * reviews
 *   external_source        facebook | google | instagram | whatsapp | other
 *                          (set exactly when source = 'external')
 *   external_source_label  the site's name the merchant typed for 'other'
 *   external_url           a link to the original review (optional)
 *   reviewed_at            the day it was written there (optional)
 *
 * The reviews a merchant added by hand before (source 'manual' or 'import')
 * are left exactly as they are: no source is guessed for them, they keep
 * showing where and how they showed, and the merchant can give one a source
 * from the dashboard (which makes it 'external').
 *
 * Run-twice safe. down turns every external review back into a hand-added one
 * (source 'manual': the author, stars, words and photos stay; where it came
 * from, its link and its date go) and removes the columns.
 */

const SOURCES = ['facebook', 'google', 'instagram', 'whatsapp', 'other'];

module.exports = {
  SOURCES,
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await qi.addColumn('reviews', 'external_source', { type: DataTypes.STRING(20), allowNull: true });
    await qi.addColumn('reviews', 'external_source_label', { type: DataTypes.STRING(60), allowNull: true });
    await qi.addColumn('reviews', 'external_url', { type: DataTypes.STRING(1000), allowNull: true });
    await qi.addColumn('reviews', 'reviewed_at', { type: DataTypes.DATEONLY, allowNull: true });
    await queryInterface.sequelize.query('ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_external_check');
    await queryInterface.sequelize.query(
      `ALTER TABLE reviews ADD CONSTRAINT reviews_external_check CHECK (
         (external_source IS NULL OR external_source IN (${SOURCES.map((s) => `'${s}'`).join(', ')}))
         AND ((source = 'external') = (external_source IS NOT NULL))
       )`
    );
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.sequelize.query('ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_external_check');
    await queryInterface.sequelize.query("UPDATE reviews SET source = 'manual' WHERE source = 'external'");
    await qi.removeColumn('reviews', 'reviewed_at');
    await qi.removeColumn('reviews', 'external_url');
    await qi.removeColumn('reviews', 'external_source_label');
    await qi.removeColumn('reviews', 'external_source');
  },
};
