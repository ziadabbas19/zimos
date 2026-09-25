'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./storefrontService');
const db = require('../../db/models');
const shippingQuoteService = require('../shipping/shippingQuoteService');
const cartService = require('../cart/cartService');
const { AppError } = require('../../core/errors/AppError');

const getStore = asyncHandler(async (req, res) => res.json({ store: await service.getStorefront(req.tenant.workspaceId) }));
const listProducts = asyncHandler(async (req, res) => res.json(await service.listProducts(req.tenant.workspaceId, req.query)));
const getProduct = asyncHandler(async (req, res) => res.json({ product: await service.getProductBySlugOrId(req.tenant.workspaceId, req.params.idOrSlug) }));
const listCollections = asyncHandler(async (req, res) => res.json({ collections: await service.listCollections(req.tenant.workspaceId) }));
const getCollection = asyncHandler(async (req, res) => res.json({ collection: await service.getCollection(req.tenant.workspaceId, req.params.collectionId) }));
// Always 200, with `result: null` when nothing matches — see service.trackOrder.
const trackOrder = asyncHandler(async (req, res) => res.json({ result: await service.trackOrder(req.tenant.workspaceId, req.query.phone, req.query.number) }));

// Items from the body, or the cart an X-Cart-Token names — the same two ways
// into checkout, except here the body's items win (the storefront may quote a
// Buy Now item while a cart exists).
const shippingQuote = asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  let items = req.body.items;
  if (!items) {
    const cartToken = req.headers['x-cart-token'];
    if (!cartToken) {
      throw new AppError('CART_TOKEN_OR_ITEM_REQUIRED', 'Send `items` in the body or an X-Cart-Token header', 400);
    }
    const cart = await db.Cart.findOne({ where: { workspaceId, guestToken: cartToken, status: 'active' } });
    if (!cart) throw new AppError('CART_NOT_FOUND', 'No active cart found for this token', 404);
    ({ items } = await cartService.toOrderItems(workspaceId, cart.id));
  }
  const quote = await shippingQuoteService.quote(workspaceId, {
    country: req.body.country,
    region: req.body.governorate,
    items,
  });
  res.json({ quote });
});

module.exports = { getStore, listProducts, getProduct, listCollections, getCollection, trackOrder, shippingQuote };
