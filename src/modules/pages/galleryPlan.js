'use strict';

const growth = require('../billing/growthFeatures');
const { planFeatureRequired } = require('../billing/planFeatureGate');

/*
 * The About page's gallery (page element `story_gallery`, pageTree.js) and
 * the plan's about_gallery (GROWTH_REQUIRE_PLAN_FEATURE, billing/growthFeatures.js).
 * Without it a page keeps the galleries it already has, exactly as they are,
 * and the live pages leave them out; nothing stored is changed, so they show
 * again with the feature.
 */

const FEATURE = 'about_gallery';
const TYPE = 'story_gallery';

const isGallery = (el) => Boolean(el && el.type === TYPE);

// Key order is not kept by jsonb, so a gallery read back and sent again unchanged compares equal.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function galleriesOf(tree) {
  const out = [];
  for (const section of (tree && tree.sections) || []) {
    for (const row of (section && section.rows) || []) {
      for (const column of (row && row.columns) || []) {
        for (const el of (column && column.elements) || []) if (isGallery(el)) out.push(stable(el));
      }
    }
  }
  return out;
}

/** A draft saved without the feature: every gallery in it must be one `before` already had (403 otherwise). */
async function assertGalleriesKept(workspaceId, before, after, { transaction } = {}) {
  const next = galleriesOf(after);
  if (next.length === 0) return;
  if (!(await growth.locked(workspaceId, FEATURE, { transaction }))) return;
  const had = new Set(galleriesOf(before));
  if (next.some((g) => !had.has(g))) throw planFeatureRequired(FEATURE);
}

/** The tree a shopper is served: without galleries while the store lacks the feature. */
async function servedTree(workspaceId, tree) {
  if (galleriesOf(tree).length === 0) return tree;
  if (!(await growth.locked(workspaceId, FEATURE))) return tree;
  return {
    ...tree,
    sections: tree.sections.map((section) => ({
      ...section,
      rows: ((section && section.rows) || []).map((row) => ({
        ...row,
        columns: ((row && row.columns) || []).map((column) => ({
          ...column,
          elements: ((column && column.elements) || []).filter((el) => !isGallery(el)),
        })),
      })),
    })),
  };
}

module.exports = { FEATURE, galleriesOf, assertGalleriesKept, servedTree };
