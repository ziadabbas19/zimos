'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * What the storefront's listing and search read with
 * STOREFRONT_SEARCH_FAST_ENABLED (storefront/productSearch.js); nothing uses
 * them while it is off. Timed on a store of 5,000 products beside another store
 * of 20,000 (REPORT-perf-batches-2-5.md has the numbers).
 *
 * products_active_newest_idx (workspace_id, priority DESC, created_at DESC, id DESC) WHERE status = 'active'
 *   The default listing, newest first: the page comes off the index and stops
 *   at LIMIT, instead of sorting all of the store's active products.
 *
 * product_variants_active_sku_trgm_idx gin (workspace_id, lower(sku) gin_trgm_ops) WHERE status = 'active'
 *   A SKU that contains the search's text.
 *
 * products_active_description_trgm_idx gin (workspace_id, <folded description> gin_trgm_ops) WHERE status = 'active'
 *   A description that contains the text, without folding each description.
 *   The expression is byte for byte productSearch.js's FOLDED_DESCRIPTION; an
 *   index on an expression that merely means the same is never used.
 *
 * Both GINs lead with the store (btree_gin): without it a word common across
 * the platform makes one store's search check every other store's rows too,
 * measured at four times the cost of no index at all.
 *
 * btree_gin ships with Postgres but a server may not offer it. Then the two GINs
 * are left out with a warning, this migration still succeeds, and the switch
 * must stay off (the deploy report has the check). Built CONCURRENTLY (no write
 * lock while they build; db/concurrentIndex drops and rebuilds an invalid
 * leftover) and run twice safely. No data is changed; down drops the indexes and
 * leaves the extension, which nothing else depends on and which costs nothing.
 */

const NEWEST = {
  name: 'products_active_newest_idx',
  table: 'products',
  definition: "(workspace_id, priority DESC, created_at DESC, id DESC) WHERE status = 'active'",
};
const TRIGRAM = [
  {
    name: 'product_variants_active_sku_trgm_idx',
    table: 'product_variants',
    definition: "USING gin (workspace_id, lower(sku) gin_trgm_ops) WHERE status = 'active'",
  },
  {
    name: 'products_active_description_trgm_idx',
    table: 'products',
    definition: "USING gin (workspace_id, zimos_normalize_search(left(coalesce(description, ''), 2000)) gin_trgm_ops) WHERE status = 'active'",
  },
];

module.exports = {
  up: async (queryInterface) => {
    const { sequelize } = queryInterface;
    await createIndexConcurrently(queryInterface, NEWEST);
    // 088 created pg_trgm; asked again so this file stands on its own.
    await sequelize.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
    try {
      await sequelize.query('CREATE EXTENSION IF NOT EXISTS btree_gin;');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`740: btree_gin is not available (${err.message}); the search indexes were not built, keep STOREFRONT_SEARCH_FAST_ENABLED off`);
      return;
    }
    for (const index of TRIGRAM) await createIndexConcurrently(queryInterface, index);
  },

  down: async (queryInterface) => {
    for (const index of [...TRIGRAM].reverse()) await dropIndexConcurrently(queryInterface, index.name);
    await dropIndexConcurrently(queryInterface, NEWEST.name);
  },
};
