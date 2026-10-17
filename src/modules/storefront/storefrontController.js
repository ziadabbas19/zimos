'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./storefrontService');
const db = require('../../db/models');
const shippingQuoteService = require('../shipping/shippingQuoteService');
const cartService = require('../cart/cartService');
const { AppError } = require('../../core/errors/AppError');

// One legal policy, variables filled in (storefront/storeInfo.js); 404 when not written.
const getPolicy = asyncHandler(async (req, res) =>
  res.json({ policy: require('./storeInfo').publicLegalPolicy(req.publicWorkspace, req.params.key) })
);
// Every public path of the store, for the storefront's sitemap.xml.
const getSitemap = asyncHandler(async (req, res) =>
  res.json({ entries: await require('./generalSettings').storeSitemap(req.publicWorkspace) })
);
// The store, its product lists and pages and its collections are the same for
// every shopper: read through the 60-second cache (storefrontCache.js), then
// put in the shopper's language.
const cache = require('./storefrontCache');
const getStore = asyncHandler(async (req, res) => {
  const ws = req.tenant.workspaceId;
  const store = await cache.cached(ws, 'store', () => service.getStorefront(ws));
  // A holiday: orders paused, or taken and shipped later (modules/holidayMode). Read
  // per request, outside the cache: it starts and ends by the clock.
  // Gift wrap and message offered at checkout (modules/giftOptions).
  const giftOptions = await cache.cached(ws, 'gift-options', () => require('../giftOptions').publicView(req.publicWorkspace));
  // The header and footer in the shopper's language, on a copy of the cached store (modules/translations).
  const localized = await require('../translations/contentTranslations').localizeShell(req, store);
  res.json({ store: { ...localized, giftOptions, holiday: require('../holidayMode').publicView(req.publicWorkspace) } });
});
// Products and collections come back in the shopper's language when the store
// has it translated (X-Store-Locale; modules/translations) — originals otherwise.
const i18n = require('../translations/translations');
const plain = (row) => (row && typeof row.toJSON === 'function' ? row.toJSON() : row);
const listProducts = asyncHandler(async (req, res) => {
  const ws = req.tenant.workspaceId;
  const result = await cache.cached(ws, `products?${cache.queryKey(req.query)}`, () => service.listProducts(ws, req.query));
  if (result && Array.isArray(result.products)) await i18n.localizeProducts(req, result.products);
  res.json(result);
});
const getProduct = asyncHandler(async (req, res) => {
  const ws = req.tenant.workspaceId;
  const product = await cache.cached(ws, `product:${req.params.idOrSlug}`, () => service.getProductBySlugOrId(ws, req.params.idOrSlug));
  await i18n.localizeProducts(req, [product]);
  res.json({ product });
});
const listCollections = asyncHandler(async (req, res) => {
  const ws = req.tenant.workspaceId;
  const collections = (await cache.cached(ws, 'collections', () => service.listCollections(ws))).map(plain);
  res.json({ collections: await i18n.localizeCollections(req, collections) });
});
const suggestProducts = asyncHandler(async (req, res) =>
  res.json(await service.suggestProducts(req.tenant.workspaceId, req.query.q))
);
const getCollection = asyncHandler(async (req, res) => {
  const ws = req.tenant.workspaceId;
  const collection = plain(await cache.cached(ws, `collection:${req.params.collectionId}`, () => service.getCollection(ws, req.params.collectionId)));
  await i18n.localizeCollections(req, [collection]);
  res.json({ collection });
});
// The signed tracking link (…/track?t=<token>): the same answer, no phone number needed.
const trackOrderByToken = asyncHandler(async (req, res) => res.json({ result: await service.trackOrderByToken(req.tenant.workspaceId, req.query.token) }));

// Always 200, with `result: null` when nothing matches — see service.trackOrder.
const trackOrder = asyncHandler(async (req, res) => res.json({ result: await service.trackOrder(req.tenant.workspaceId, req.query.phone, req.query.number) }));

// Items from the body, or the cart an X-Cart-Token names — the same two ways
// into checkout, except here the body's items win (the storefront may quote a
// Buy Now item while a cart exists).
const shippingQuote = asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  let items = req.body.items;
  // A product A/B test: priced for this visitor, or for whoever filled the cart (catalog/productTests.js).
  let testVisitor = require('../catalog/productTests').visitorOf(req);
  if (!items) {
    const cartToken = req.headers['x-cart-token'];
    if (!cartToken) {
      throw new AppError('CART_TOKEN_OR_ITEM_REQUIRED', 'Send `items` in the body or an X-Cart-Token header', 400);
    }
    const cart = await db.Cart.findOne({ where: { workspaceId, guestToken: cartToken, status: 'active' } });
    if (!cart) throw new AppError('CART_NOT_FOUND', 'No active cart found for this token', 404);
    ({ items } = await cartService.toOrderItems(workspaceId, cart.id));
    testVisitor = cart.visitorId || testVisitor;
  }
  // Only a published funnel's price, for what it sells (funnels/funnelCheckout.js).
  await require('../funnels/funnelCheckout').assertSells(workspaceId, req.body.funnelId, items);
  const quote = await shippingQuoteService.quote(workspaceId, {
    country: req.body.country,
    region: req.body.governorate,
    items: await require('../catalog/productTests').pinPrices(workspaceId, items, testVisitor),
    // A funnel's checkout: priced with the funnel's shipping group (funnels/funnelShipping.js).
    funnelId: req.body.funnelId || null,
  });
  res.json({ quote });
});

module.exports = {
  getStore,
  getPolicy,
  getSitemap,
  listProducts,
  getProduct,
  suggestProducts,
  listCollections,
  getCollection,
  trackOrder,
  trackOrderByToken,
  shippingQuote,
};
