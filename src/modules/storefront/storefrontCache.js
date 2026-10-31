'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * A 60-second cache for what every shopper of a store reads alike (SPEC
 * §3.5): the store itself, its product lists and pages, its collections.
 * Only the raw data is cached — the shopper's language is applied after the
 * read, per request — and nothing per-shopper (cart, preview, tracking)
 * goes through it.
 *
 * A store's entries are dropped the moment an audited change to its
 * catalog, offers, settings or pages commits (onAudit, called by
 * recordAudit): each store has a generation that the change bumps, and
 * every key carries it. Orders do not bump it (a busy store would never
 * hit the cache); stock shown is at most 60 s old, and checkout always
 * checks the real stock.
 *
 * invalidate() is also where the store's pages are dropped from Cloudflare's
 * cache (cloudflarePurge.js, CLOUDFLARE_PURGE_ENABLED): every audited change
 * that drops this cache, and every write outside the audit log that calls
 * invalidate() itself, purges the store's host too, whether or not this
 * cache is on.
 *
 * The entries and generations live in this process's memory, so with several
 * API instances a change shows on the others within the TTL. A cache failure
 * is never the request's: it falls back to reading the database.
 *
 * Off unless STOREFRONT_CACHE_TTL_SECONDS is set above 0.
 */

const TTL_SECONDS = Number(process.env.STOREFRONT_CACHE_TTL_SECONDS || 0);
const MAX_MEMORY_ENTRIES = 5000;
const enabled = !env.isTest && TTL_SECONDS > 0;

// Audited entity types whose change shows on the storefront.
const STORE_ENTITIES = new Set([
  'Workspace',
  'Product',
  'ProductVariant',
  'Collection',
  'Offer',
  'Bundle',
  'Discount',
  'Review',
  'Website',
  'WebsitePage',
  'ShippingZone',
  'ShippingRate',
  'TaxRate',
  'TrackingPixel',
  'WorkspaceCustomCode',
  'Domain',
  'Translation',
  'Media',
  // An app installed or taken off (pixels, offers).
  'WorkspaceApp',
  // Shown on the store's pages too: the combos and specs of a product page,
  // its answered questions and size chart, the blog, the looks, the courses
  // (/learn), the shipping and delivery zones offered, redirects, a product
  // page's A/B test, and the subscription and the console's feature grants
  // (a store going live, a plan that changes what it may show, the
  // platform's branding hidden or shown).
  'ProductCombo',
  'SpecKey',
  'ProductQuestion',
  'SizeChart',
  'BlogPost',
  'BlogCategory',
  'ShoppableImage',
  'Course',
  'ShippingProfile',
  'DeliveryZone',
  'UrlRedirect',
  'Experiment',
  'Subscription',
  'WorkspaceFeatureOverride',
]);

// Audited actions on those that change nothing a shopper sees: a read, a
// review waiting for moderation, a file added to the library and not used
// yet, a pixel's test event.
const UNSEEN_ACTIONS = new Set(['product.export', 'review.submit', 'media.upload', 'tracking_pixel.test_event']);

// --- memory backend ----------------------------------------------------------
const memory = new Map(); // key → { expiresAt, json }
const generations = new Map(); // workspaceId → n

const memoryBackend = {
  async generation(workspaceId) {
    return generations.get(workspaceId) || 0;
  },
  async bump(workspaceId) {
    generations.set(workspaceId, (generations.get(workspaceId) || 0) + 1);
  },
  async get(key) {
    const hit = memory.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      memory.delete(key);
      return null;
    }
    return hit.json;
  },
  async set(key, json) {
    if (memory.size >= MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
    memory.set(key, { expiresAt: Date.now() + TTL_SECONDS * 1000, json });
  },
};

const backend = () => memoryBackend;

/**
 * `compute()`'s result for this store and key, at most TTL old. Always a
 * fresh plain copy, so the caller may change it (localization does).
 */
async function cached(workspaceId, key, compute) {
  if (!enabled || !workspaceId) return JSON.parse(JSON.stringify(await compute()));
  let full = null;
  const store = backend();
  try {
    full = `sf:${workspaceId}:${await store.generation(workspaceId)}:${key}`;
    const hit = await store.get(full);
    if (hit) return JSON.parse(hit);
  } catch (err) {
    logger.warn(`[storefront-cache] read failed: ${err.message}`);
    full = null;
  }
  const json = JSON.stringify(await compute());
  if (full) {
    try {
      await store.set(full, json);
    } catch (err) {
      logger.warn(`[storefront-cache] write failed: ${err.message}`);
    }
  }
  return JSON.parse(json);
}

/**
 * Drops every cached entry of the store, here and at the edge (its pages at
 * Cloudflare, cloudflarePurge.js; fire and forget). `previousSlug`: the
 * address the store just left, whose pages go too.
 */
async function invalidate(workspaceId, { previousSlug = null } = {}) {
  if (!workspaceId) return;
  require('./cloudflarePurge').purgeStore(workspaceId, { previousSlug });
  if (!enabled) return;
  try {
    await backend().bump(workspaceId);
  } catch (err) {
    logger.warn(`[storefront-cache] invalidation failed: ${err.message}`);
  }
}

/** recordAudit's hook: a committed change the storefront shows drops the store's cache. */
function onAudit({ workspaceId, action, entityType, before, after, transaction }) {
  if (!workspaceId || !STORE_ENTITIES.has(entityType) || UNSEEN_ACTIONS.has(action)) return;
  // A new address (workspace.update): the pages kept under the old one go too.
  const previousSlug =
    entityType === 'Workspace' && before && after && before.slug && after.slug && before.slug !== after.slug ? before.slug : null;
  const drop = () => invalidate(workspaceId, { previousSlug });
  if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(drop);
  else drop();
}

/** A key part for a query object, the same whatever the order of its fields. */
function queryKey(query) {
  const q = query || {};
  return Object.keys(q)
    .sort()
    .map((k) => `${k}=${Array.isArray(q[k]) ? q[k].join(',') : JSON.stringify(q[k])}`)
    .join('&');
}

module.exports = { cached, invalidate, onAudit, queryKey, TTL_SECONDS, STORE_ENTITIES, UNSEEN_ACTIONS };
