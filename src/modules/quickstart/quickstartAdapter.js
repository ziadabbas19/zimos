'use strict';

/**
 * Helpers for the quickstart viewer: money formatting, form parsing, and a
 * valid page tree for the storefront "/" page so `pageTree.validatePageTree`
 * still applies. The EJS renderer reads live data (products + branding), not
 * the tree — the tree is just kept valid.
 */

function formatMoney(minorAmount, currency) {
  const n = Number(minorAmount || 0) / 100;
  return `${currency || 'EGP'} ${n.toFixed(2)}`;
}

function parsePriceToMinor(raw) {
  const n = parseFloat(String(raw).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function parseBullets(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
}

/**
 * A valid, minimal "store home" page tree: a heading + a `product_list`
 * element. Real rendering lists every active product live.
 */
function storeHomeTree(storeName) {
  return {
    version: 1,
    sections: [
      {
        id: 'store-section',
        type: 'section',
        settings: {},
        rows: [
          {
            id: 'store-row',
            type: 'row',
            settings: {},
            columns: [
              {
                id: 'store-col',
                type: 'column',
                span: 12,
                settings: {},
                elements: [
                  { id: 'store-title', type: 'heading', props: { text: storeName || 'Store', level: 1 } },
                  { id: 'store-products', type: 'product_list', props: { source: 'all_active' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

module.exports = { formatMoney, parsePriceToMinor, parseBullets, storeHomeTree };
