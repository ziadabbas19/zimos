'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const reviewService = require('../reviews/reviewService');

/**
 * Public (no-auth) storefront queries: only status='active' rows, and only
 * shopper-facing fields — no cost price, internal notes, or draft/archived
 * items. Don't reuse the staff catalog service here; it has no such filter.
 */

function toPublicVariant(variant) {
  return {
    id: variant.id,
    sku: variant.sku,
    optionValues: variant.optionValues,
    priceAmount: variant.priceAmount,
    compareAtAmount: variant.compareAtAmount,
    currency: variant.currency,
    weightGrams: variant.weightGrams,
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

function toPublicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    productType: product.productType,
    media: product.media,
    tags: product.tags,
    seo: product.seo,
    variants: (product.variants || []).map(toPublicVariant),
    offers: (product.offers || []).map(toPublicOffer),
  };
}

async function listProducts(workspaceId, { collectionId, tag, search, limit = 24, cursor } = {}) {
  const where = { workspaceId, status: 'active' };
  if (cursor) where.id = { [db.Sequelize.Op.gt]: cursor };
  if (tag) where.tags = { [db.Sequelize.Op.contains]: [tag] };
  if (search) where.name = { [db.Sequelize.Op.iLike]: `%${search}%` };

  const include = [
    { model: db.ProductVariant, as: 'variants', where: { status: 'active' }, required: false },
    { model: db.Offer, as: 'offers', where: { status: 'active' }, required: false, include: [{ model: db.OfferVariant, as: 'lines' }] },
  ];
  if (collectionId) {
    include.push({ model: db.Collection, as: 'collections', where: { id: collectionId }, attributes: [] });
  }

  const products = await db.Product.findAll({ where, include, order: [['id', 'ASC']], limit: limit + 1 });
  const hasMore = products.length > limit;
  const page = products.slice(0, limit);

  return { products: page.map(toPublicProduct), nextCursor: hasMore ? page[page.length - 1].id : null };
}

async function getProductBySlugOrId(workspaceId, idOrSlug) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const product = await db.Product.findOne({
    where: { workspaceId, status: 'active', ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }) },
    include: [
      { model: db.ProductVariant, as: 'variants', where: { status: 'active' }, required: false },
      { model: db.Offer, as: 'offers', where: { status: 'active' }, required: false, include: [{ model: db.OfferVariant, as: 'lines' }] },
    ],
  });
  if (!product) throw new NotFoundError('Product');

  const { rating, reviews } = await reviewService.publicRatingFor(workspaceId, product.id);
  return { ...toPublicProduct(product), rating, reviews };
}

/** Public store metadata: branding + the opaque themeSettings blob. */
async function getStorefront(workspaceId) {
  const w = await db.Workspace.findOne({
    where: { id: workspaceId },
    attributes: ['id', 'name', 'slug', 'logoUrl', 'tagline', 'themeSettings', 'defaultCurrency'],
  });
  if (!w) throw new NotFoundError('Workspace');
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    logoUrl: w.logoUrl,
    tagline: w.tagline,
    themeSettings: w.themeSettings || {},
    currency: w.defaultCurrency,
  };
}

async function listCollections(workspaceId) {
  return db.Collection.findAll({ where: { workspaceId }, attributes: ['id', 'name', 'slug', 'description', 'seo'] });
}

async function getCollection(workspaceId, collectionId) {
  const collection = await db.Collection.findOne({ where: { id: collectionId, workspaceId }, attributes: ['id', 'name', 'slug', 'description', 'seo'] });
  if (!collection) throw new NotFoundError('Collection');
  return collection;
}

module.exports = {
  getStorefront,
  listProducts,
  getProductBySlugOrId,
  listCollections,
  getCollection,
  toPublicVariant,
};
