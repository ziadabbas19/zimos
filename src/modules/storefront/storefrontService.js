'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const reviewService = require('../reviews/reviewService');
const { resolveCheckoutSettings } = require('../checkout/checkoutSettings');

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
    attributes: ['id', 'name', 'slug', 'logoUrl', 'tagline', 'themeSettings', 'defaultCurrency', 'settings'],
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
    // Which optional fields the checkout form should show or demand. Always
    // fully populated — an unconfigured store gets the defaults, which are
    // what the checkout already enforced before this existed.
    checkout: resolveCheckoutSettings(w),
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

/* --- Public order tracking ---------------------------------------------- */

// The four stages the shopper-facing tracker shows. Deliberately coarser than
// the order's three state machines: it answers "where is my parcel", not
// "what is this order's financial state".
const STAGE = { PLACED: 0, CONFIRMATION: 1, SHIPPED: 2, DELIVERED: 3 };

// Shipment statuses that mean the parcel has left us but hasn't arrived.
// 'created' and 'picked_up' are not included: a waybill existing isn't
// something the shopper can see moving yet.
const IN_TRANSIT_STATUSES = ['in_transit', 'out_for_delivery'];

/**
 * Highest stage any shipment has reached, falling back to the order's own
 * confirmation state. Checked newest-first, because an order split across two
 * parcels can have one delivered while another is still moving.
 *
 * Note this collapses 'rejected', 'unreachable' and 'postponed' onto stage 0
 * along with 'pending' — the tracker has no stage for an order that stopped,
 * and a cancelled order keeps showing as placed.
 */
function trackingStage(order, shipments) {
  if (shipments.some((s) => s.status === 'delivered')) return STAGE.DELIVERED;
  if (shipments.some((s) => IN_TRANSIT_STATUSES.includes(s.status))) return STAGE.SHIPPED;
  if (order.confirmationState === 'confirmed') return STAGE.CONFIRMATION;
  return STAGE.PLACED;
}

/** The most recent of some nullable dates, or null if none are set. */
function latestDate(dates) {
  const times = dates.filter(Boolean).map((d) => new Date(d).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * When the stage the shopper is being shown was actually reached — not when
 * the row last changed, so an unrelated edit (a note, a phone correction)
 * doesn't look like delivery progress. Falls back to the order's own
 * updatedAt when the carrier gave us a status but no timestamp.
 */
function trackingUpdatedAt(order, shipments, stage) {
  let at = null;
  if (stage === STAGE.DELIVERED) {
    at = latestDate(shipments.filter((s) => s.status === 'delivered').map((s) => s.deliveredAt));
  } else if (stage === STAGE.SHIPPED) {
    at = latestDate(shipments.filter((s) => IN_TRANSIT_STATUSES.includes(s.status)).map((s) => s.shippedAt));
  }
  return at || (order.updatedAt ? new Date(order.updatedAt) : null);
}

/**
 * Looks up one order for the shopper who placed it, from phone + order number.
 * Both are required and both are matched inside this workspace, so it can
 * neither read another store's orders nor confirm that a phone number exists.
 *
 * Returns null rather than throwing NotFoundError on every miss: a 404 for
 * "no such order" that differed from a 200 for "wrong phone" would tell a
 * guesser which half they got right. The caller answers 200 { result: null }.
 *
 * Amounts stay in minor units as strings (BIGINT columns) — the shopper's
 * currency is returned alongside for formatting. No contact details, address
 * or internal state leak into the response.
 */
async function trackOrder(workspaceId, phone, orderNumber) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return null;

  const customer = await db.Customer.findOne({ where: { workspaceId, phoneNormalized }, attributes: ['id'] });
  if (!customer) return null;

  const order = await db.Order.findOne({
    // (workspace_id, order_number) is unique, so customerId here is an
    // authorization check rather than part of the lookup.
    where: { workspaceId, customerId: customer.id, orderNumber: String(orderNumber).trim().toUpperCase() },
    include: [
      { model: db.OrderItem, as: 'items' },
      { model: db.Shipment, as: 'shipments' },
    ],
    order: [['createdAt', 'DESC']],
  });
  if (!order) return null;

  const shipments = order.shipments || [];
  const stage = trackingStage(order, shipments);
  const updatedAt = trackingUpdatedAt(order, shipments, stage);

  return {
    orderNumber: order.orderNumber,
    stage,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
    items: (order.items || []).map((item) => ({
      productNameSnapshot: item.productNameSnapshot,
      quantity: item.quantity,
      lineTotalAmount: String(item.lineTotalAmount),
    })),
    subtotalAmount: String(order.subtotalAmount),
    discountAmount: String(order.discountAmount),
    shippingAmount: String(order.shippingAmount),
    totalAmount: String(order.totalAmount),
    currency: order.currency,
  };
}

module.exports = {
  getStorefront,
  listProducts,
  getProductBySlugOrId,
  listCollections,
  getCollection,
  trackOrder,
  toPublicVariant,
};
