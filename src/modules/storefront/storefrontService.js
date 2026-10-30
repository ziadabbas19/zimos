'use strict';

const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const reviewService = require('../reviews/reviewService');
const { resolveCheckoutSettings } = require('../checkout/checkoutSettings');
const { resolveThankYouPage } = require('./thankYouPage');
const { publicStoreInfo, publicLegalIndex } = require('./storeInfo');
const { publicNavPages } = require('../pages/pageFlags');
const { publicGeneralSettings } = require('./generalSettings');
const { resolveCatalogSettings } = require('./catalogSettings');
const { presentStoreBump } = require('../checkout/orderBump');
const { toPublicProduct, toPublicVariant, publicAttributes, publicInclude } = require('./publicProduct');
const productSearch = require('./productSearch');
const { notHiddenSql } = require('../catalog/productPage');

/**
 * Public (no-auth) storefront queries: only status='active' rows, and only
 * shopper-facing fields — no cost price, internal notes, or draft/archived
 * items (./publicProduct.js). Don't reuse the staff catalog service here; it
 * has no such filter.
 */

// Any of these asks for the search / filter / sort listing (./productSearch.js).
const LISTING_PARAMS = ['search', 'collection', 'minPrice', 'maxPrice', 'options', 'sort', 'page', 'facets'];

function wantsListing(query) {
  if (LISTING_PARAMS.some((key) => query[key] !== undefined && query[key] !== '' && query[key] !== false)) return true;
  // Several tags at once is the new filter; one tag stays on the old path.
  return Array.isArray(query.tag);
}

/**
 * The public product list. Plain requests (limit, collectionId, one tag,
 * cursor) keep the original id-ordered cursor paging every existing caller
 * relies on; anything from LISTING_PARAMS goes to productSearch.
 */
async function listProducts(workspaceId, query = {}) {
  if (wantsListing(query)) return productSearch.searchProducts(workspaceId, query);

  const { collectionId, tag, limit = 24, cursor } = query;
  // A hidden product opens by its link only (page_settings.hidden).
  const where = { workspaceId, status: 'active', [db.Sequelize.Op.and]: [db.sequelize.literal(notHiddenSql('"Product"'))] };
  if (cursor) where.id = { [db.Sequelize.Op.gt]: cursor };
  if (tag) where.tags = { [db.Sequelize.Op.contains]: [tag] };

  const include = publicInclude();
  if (collectionId) {
    include.push({ model: db.Collection, as: 'collections', where: { id: collectionId }, attributes: [] });
  }

  const products = await db.Product.findAll({ where, attributes: publicAttributes(), include, order: [['id', 'ASC']], limit: limit + 1 });
  const hasMore = products.length > limit;
  const page = products.slice(0, limit);

  return { products: page.map(toPublicProduct), nextCursor: hasMore ? page[page.length - 1].id : null };
}

async function getProductBySlugOrId(workspaceId, idOrSlug) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const product = await db.Product.findOne({
    where: { workspaceId, status: 'active', ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }) },
    attributes: publicAttributes(),
    include: publicInclude(),
  });
  if (!product) throw new NotFoundError('Product');

  // The stars (published reviews from delivered purchases only) and the published reviews,
  // with first name, photos and the verified-buyer flag (reviews/reviewService.js).
  const { rating, reviews, externalReviews } = await reviewService.publicProductReviews(workspaceId, product.id);
  const publicProduct = toPublicProduct(product);
  // The product's quantity bundle, every tier priced for every variant (null when it has none).
  const bundlePricing = require('../bundles/bundlePricing');
  const bundle = (await bundlePricing.bundlesForProducts(workspaceId, [product.id])).get(product.id);
  return {
    ...publicProduct,
    // The website page the merchant built as this product's page (page settings → landing page), or null.
    landingPagePath: await require('../catalog/productLanding').landingPathFor(workspaceId, product.pageSettings),
    // For the "similar products" section: products sharing a collection.
    collectionIds: (await db.ProductCollection.findAll({ where: { productId: product.id }, attributes: ['collectionId'] })).map((r) => r.collectionId),
    bundle: bundle ? bundlePricing.presentBundle(bundle, publicProduct.variants) : null,
    // Menu options: the product's active option groups and choices ([] when it has none, catalog/menuOptions.js).
    optionGroups: await require('../catalog/menuOptions').publicGroups(workspaceId, product.id),
    // A running A/B test: the page asks for this visitor's prices and pictures (catalog/productTests.js).
    abTest: await require('../catalog/productTests').hasRunningTest(workspaceId, product.id),
    // Sold beyond stock as a pre-order: { shipsAt, message, limited } or null (modules/preorders).
    preorder: require('../preorders').publicView(product),
    // { min, max, maxPerCustomer } or null (catalog/purchaseLimits.js).
    purchaseLimits: require('../catalog/purchaseLimits').limitsOf(product),
    rating,
    reviews,
    // Reviews the merchant brought from other sites, shown apart with their source (never in `rating`).
    externalReviews,
    // The combos this page offers ([] while PRODUCT_COMBOS_ENABLED is off, modules/combos).
    combos: await require('../combos/comboService').forProduct(workspaceId, product.id),
  };
}

/** Public store metadata: branding + the opaque themeSettings blob. */
async function getStorefront(workspaceId) {
  const w = await db.Workspace.findOne({
    where: { id: workspaceId },
    attributes: ['id', 'name', 'slug', 'logoUrl', 'tagline', 'themeSettings', 'defaultCurrency', 'defaultLocale', 'settings'],
  });
  if (!w) throw new NotFoundError('Workspace');
  return {
    // The store's own language and the ones it offers besides (modules/translations).
    ...require('../translations/translations').languagesOf(w),
    id: w.id,
    name: w.name,
    slug: w.slug,
    // The store's canonical host when it has a primary domain that can be served (domains/primaryHost.js).
    primaryHost: await require('../domains/primaryHost').primaryHostOf(w.id),
    logoUrl: w.logoUrl,
    tagline: w.tagline,
    themeSettings: w.themeSettings || {},
    currency: w.defaultCurrency,
    // The store's currency format (dashboard → currencies): symbol position and decimals.
    currencyFormat: (({ symbolPosition = 'auto', decimals = 'auto' }) => ({ symbolPosition, decimals }))((w.settings && w.settings.currencies) || {}),
    // Which optional fields the checkout form should show or demand. Always
    // fully populated — an unconfigured store gets the defaults, which are
    // what the checkout already enforced before this existed.
    checkout: resolveCheckoutSettings(w),
    // Self delivery: the governorates the store delivers to (null = everywhere, shipping/deliveryAreas.js).
    delivery: {
      servedGovernorates: require('../shipping/deliveryAreas').servedGovernorates(w.settings),
      // Pickup from the store: its address, phone and note, or null while off (shipping/storePickup.js).
      pickup: require('../shipping/storePickup').publicPickup(w.settings),
      // Delivery zones inside a city: the active ones while the store prices by them, else null.
      zones: await require('../shipping/deliveryZones').publicZones(w),
      // Opening hours, open now or not (null while off), and the usual delivery time in minutes.
      hours: require('../shipping/storeHours').publicHours(w.settings),
      etaMinutes: require('../shipping/storeHours').etaMinutes(w.settings),
    },
    // What the thank-you page shows after an order (settings.thank_you_page).
    thankYou: resolveThankYouPage(w.settings),
    // Contact details and trust cards (null while switched off), which legal
    // policies exist (GET /store/:ws/policies/:key serves each), and the
    // pages the merchant put in the header or footer.
    storeInfo: publicStoreInfo(w.settings),
    legal: publicLegalIndex(w.settings),
    navPages: await publicNavPages(w.id),
    // Collections flagged "show in header" (catalog → collections).
    headerCollections: await headerCollections(w.id),
    // general, social, floatingWhatsapp, seo (storefront/generalSettings.js).
    ...publicGeneralSettings(w.settings),
    // "Powered by ZIMOS" and the fallback logo stay unless the merchant hid
    // them AND the store has remove_branding (storefront/platformBranding.js).
    removeBranding: await require('./platformBranding').isHidden(w),
    // The product listing's sidebar, filters and default sort.
    catalog: resolveCatalogSettings(w.settings),
    // The "add to your order" card the store's checkout offers, or null
    // (none set, or its offer is archived / out of stock).
    orderBump: await presentStoreBump(w),
    // The store as an installable app for its shoppers, or null (storeApp.js).
    storeApp: require('./storeApp').publicStoreApp(w),
    // The store's own stars (published store reviews from delivered purchases,
    // reviews/reviewRating.js) and whether shoppers may send reviews now
    // (REVIEWS_PUBLIC_SUBMISSION_ENABLED): the storefront shows its forms only then.
    // Neither while the plan lacks `reviews` (billing/growthFeatures.js).
    reviews: await storeReviewsState(w.id),
    // The browser ad-pixel IDs; the rest of settings stays private.
    ...(await publicTracking(w.id)),
  };
}

async function storeReviewsState(workspaceId) {
  const reviewRating = require('../reviews/reviewRating');
  if (await require('../billing/growthFeatures').locked(workspaceId, 'reviews')) return { open: false, storeRating: reviewRating.emptyRating() };
  return { open: require('../../config/env').reviews.publicSubmissionEnabled, storeRating: await reviewRating.storeRating(workspaceId) };
}

// The browser pixels (tracking_pixels table, marketing/trackingPixelService):
// `trackingPixels` is the full list with each pixel's scope; `tracking` keeps
// the older one-ID-per-platform shape (the first store-wide pixel of each).
async function publicTracking(workspaceId) {
  const trackingPixels = await require('../marketing/trackingPixelService').publicPixels(workspaceId);
  const legacyKey = { meta: 'meta', tiktok: 'tiktok', snapchat: 'snapchat', google: 'googleTag' };
  const tracking = {};
  for (const p of trackingPixels) {
    const key = legacyKey[p.platform];
    if (key && p.scope.type === 'all' && !tracking[key]) tracking[key] = p.pixelId;
  }
  // on_order | on_confirmed | on_delivered — the browser pixel only reports
  // Purchase itself with on_order (marketing/purchaseTiming.js).
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['settings'] });
  const purchaseEventTiming = require('../marketing/purchaseTiming').timingOf(workspace && workspace.settings);
  return { tracking, trackingPixels, purchaseEventTiming };
}

const PUBLIC_COLLECTION_FIELDS = ['id', 'name', 'slug', 'description', 'seo', 'parentId', 'position', 'imageUrl', 'showInHeader'];

/** The collections the merchant put in the header menu, in their order. */
async function headerCollections(workspaceId) {
  const rows = await db.Collection.findAll({
    where: { workspaceId, showInHeader: true, hidden: false },
    attributes: ['id', 'name', 'slug'],
    order: [
      ['position', 'ASC'],
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: 12,
  });
  return rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug }));
}

/**
 * The store's collections as a flat list, in the merchant's order; `parentId`
 * builds the tree. A hidden collection is left out (its own link still opens).
 */
async function listCollections(workspaceId) {
  return db.Collection.findAll({
    where: { workspaceId, hidden: false },
    attributes: PUBLIC_COLLECTION_FIELDS,
    order: [
      ['position', 'ASC'],
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
  });
}

/** One collection, by id or by slug. */
async function getCollection(workspaceId, idOrSlug) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const collection = await db.Collection.findOne({
    where: { workspaceId, ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }) },
    attributes: PUBLIC_COLLECTION_FIELDS,
  });
  if (!collection) throw new NotFoundError('Collection');
  return collection;
}

/** The search box's suggestions — see productSearch.suggest. */
async function suggestProducts(workspaceId, q) {
  return productSearch.suggest(workspaceId, q);
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
  return presentTrackedOrder(workspaceId, order);
}

/** The same answer for an order reached through its signed tracking link (orderTrackingExtras.js). */
async function trackOrderByToken(workspaceId, token) {
  const order = await require('./orderTrackingExtras').orderFromToken(workspaceId, token);
  return order ? presentTrackedOrder(workspaceId, order) : null;
}

/** What the shopper sees of one of their orders. No contact details, address or internal state. */
async function presentTrackedOrder(workspaceId, order) {
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
    // The five steps with their times, whether the order stopped (cancelled,
    // returned), the courier and waybill, and the signed tracking link's token.
    ...require('./orderTrackingExtras').extras(order, shipments),
    // What the store wrote for the customer (order notes marked public).
    notes: await require('../orders/orderMetaService').publicNotes(order.id),
    // Download links of the digital products in a paid order (modules/digital).
    downloads: await require('../digital/digitalService').publicGrantsForOrder(workspaceId, order.id),
  };
}

module.exports = {
  getStorefront,
  listProducts,
  getProductBySlugOrId,
  listCollections,
  getCollection,
  suggestProducts,
  trackOrder,
  trackOrderByToken,
  toPublicVariant,
  // Shopper accounts show their orders the same way (shopperAccounts/).
  trackingStage,
  presentTrackedOrder,
};
