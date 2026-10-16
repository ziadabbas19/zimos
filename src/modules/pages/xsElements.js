'use strict';

/**
 * The imported store templates' bands ("xs" looks): one element type per kind
 * of band — a slider, a row of banners, a product grid, a contact block… —
 * each drawn in the look of the template its `look` prop names (the
 * storefront's page-renderer/xs). They are ordinary page-tree elements (typed
 * props, never markup), registered into pageTree.js's allowlist from here so
 * that file only gains two lines.
 *
 * They declare no prop rules: like the original types, their props only have
 * to be an object. PAGE_TREE_STRICT_PROPS checks only the types that have a
 * rule set, so it leaves them alone too. The storefront resolves every link
 * and picture address they carry itself before drawing it.
 *
 * The AI features do not offer them (ai/features.js, ai/featuresP2.js): a
 * generated page has no template look to draw them in.
 */

const TYPES = [
  'xs_slider',
  'xs_banners',
  'xs_products',
  'xs_title',
  'xs_story',
  'xs_contact',
  'xs_hero',
  'xs_showcase',
  'xs_features',
  'xs_split',
  'xs_minis',
  'xs_quotes',
  'xs_gallery',
  'xs_newsletter',
  'xs_team',
  'xs_video',
  'xs_posts',
];

const TYPE_SET = new Set(TYPES);

/** Whether an element type is one of the imported templates' bands. */
const isXsType = (type) => TYPE_SET.has(type);

module.exports = { TYPES, isXsType };
