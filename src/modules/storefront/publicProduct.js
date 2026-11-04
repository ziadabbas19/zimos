'use strict';

const db = require('../../db/models');
const { resolvePageSettings, resolveCms, effectiveVariantPrice } = require('../catalog/productPage');

/**
 * The shopper-facing shape of a product: only status='active' rows and only
 * public fields — no cost price, internal notes, or draft/archived items.
 * Shared by the storefront listing, product page and search.
 */

function toPublicVariant(variant, product) {
  // After a countdown offer ends the shopper sees (and pays) the full price.
  const price = effectiveVariantPrice(variant, product || variant.product);
  return {
    id: variant.id,
    sku: variant.sku,
    optionValues: variant.optionValues,
    priceAmount: price.priceAmount,
    compareAtAmount: price.compareAtAmount,
    currency: variant.currency,
    weightGrams: variant.weightGrams,
    // Its own picture, when the merchant gave it one (SPEC §7.2).
    imageUrl: variant.imageUrl || null,
    // Availability is exposed as a boolean, not exact counts, so shoppers
    // (and competitors) never see precise stock levels via the public API.
    inStock: variant.allowOverselling || variant.stockOnHand - variant.reservedStock > 0,
  };
}

function toPublicOffer(offer) {
  return {
    id: offer.id,
    name: offer.name,
    pricingMode: offer.pricingMode,
    priceAmount: offer.priceAmount,
    currency: offer.currency,
    badge: offer.badge,
    isDefault: offer.isDefault,
    lines: (offer.lines || []).map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
  };
}

/**
 * What a product card never draws. `?fields=card` on the product list leaves
 * these out (the columns are not read, so a list of long descriptions costs
 * neither the database nor the page's HTML); without it a list answers as it
 * always did. Page settings stay: a card's price depends on them (a countdown).
 */
const CARD_OMITS = ['description', 'seo', 'cms'];

/** The list's own query: whether it asked for cards. */
const wantsCards = (query) => Boolean(query) && query.fields === 'card';

/** Takes those fields off a public product (a translation overlay can put a description back). */
function omitCardFields(product) {
  for (const field of CARD_OMITS) delete product[field];
  return product;
}

function toPublicProduct(product, { card = false } = {}) {
  const full = fullPublicProduct(product);
  return card ? omitCardFields(full) : full;
}

function fullPublicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    productType: product.productType,
    media: product.media,
    tags: product.tags,
    seo: product.seo,
    variants: (product.variants || []).map((variant) => toPublicVariant(variant, product)),
    // How each option is drawn (buttons, dropdown, colour swatches, images).
    options: Array.isArray(product.options) ? product.options : [],
    priority: product.priority || 0,
    specialOfferText: product.specialOfferText || null,
    shippingMode: product.shippingMode,
    pageSettings: resolvePageSettings(product.pageSettings),
    cms: resolveCms(product.cms),
    offers: (product.offers || []).map(toPublicOffer),
    // The fields the shopper fills in when ordering; [] for most products.
    customFields: Array.isArray(product.customFields) ? product.customFields : [],
    // Menu options to pick on the product page (a card sends the shopper there instead of adding).
    // Absent when the row was loaded without publicAttributes().
    ...(typeof product.get === 'function' && product.get('hasOptionGroups') !== undefined
      ? { hasOptionGroups: Boolean(product.get('hasOptionGroups')) }
      : {}),
    // Paid every period or in installments (SPEC §18.1); null when sold once.
  };
}

/**
 * The product's columns plus `hasOptionGroups`: whether it has an active menu
 * option group with an active choice (catalog/menuOptions.js publicGroups).
 * An EXISTS in the same SELECT, so a list costs no query per product.
 */
const publicAttributes = ({ card = false } = {}) => ({
  ...(card ? { exclude: CARD_OMITS } : {}),
  include: [
    [
      db.sequelize.literal(
        'EXISTS (SELECT 1 FROM product_option_groups g JOIN product_option_choices c ON c.group_id = g.id AND c.active = true ' +
          'WHERE g.workspace_id = "Product"."workspace_id" AND g.product_id = "Product"."id" AND g.active = true)'
      ),
      'hasOptionGroups',
    ],
  ],
});

const publicInclude = () => [
  { model: db.ProductVariant, as: 'variants', where: { status: 'active' }, required: false },
  {
    model: db.Offer,
    as: 'offers',
    where: { status: 'active' },
    required: false,
    include: [{ model: db.OfferVariant, as: 'lines' }],
  },
];

/** Active products by id, in the order of `ids`, in their public shape. */
async function loadPublicProducts(workspaceId, ids, { card = false } = {}) {
  if (ids.length === 0) return [];
  const rows = await db.Product.findAll({
    where: { id: ids, workspaceId, status: 'active' },
    attributes: publicAttributes({ card }),
    include: publicInclude(),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((row) => toPublicProduct(row, { card }));
}

module.exports = { toPublicVariant, toPublicOffer, toPublicProduct, publicAttributes, publicInclude, loadPublicProducts, wantsCards, omitCardFields };
