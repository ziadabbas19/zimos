'use strict';
const asyncHandler = require('express-async-handler');
const cartService = require('../cart/cartService');
const orderService = require('../orders/orderService');
const checkoutSessionService = require('../checkoutSessions/checkoutSessionService');
const { AppError } = require('../../core/errors/AppError');
const { assertRequiredCheckoutFields } = require('./checkoutSettings');

/**
 * Guest checkout (no login). Runs the same orderService.createOrder as the
 * staff API. Two ways in: an `X-Cart-Token` header builds the order from that
 * cart's lines, or — with no token — a single `item` in the body ("Buy now")
 * goes straight to an order with no cart. The cart wins if both are given.
 */
const checkout = asyncHandler(async (req, res) => {
  const cartToken = req.headers['x-cart-token'];
  const { item, checkoutSessionId, ...orderBody } = req.body;

  // Per-store required fields (settings.checkout_settings). Checked before any
  // cart work so a rejected checkout costs nothing.
  assertRequiredCheckoutFields(req.publicWorkspace, req.body);

  let items;
  let cart = null;

  if (cartToken) {
    cart = await require('../../db/models').Cart.findOne({
      where: { workspaceId: req.tenant.workspaceId, guestToken: cartToken, status: 'active' },
    });
    if (!cart) throw new AppError('CART_NOT_FOUND', 'No active cart found for this token', 404);
    ({ items } = await cartService.toOrderItems(req.tenant.workspaceId, cart.id));
  } else if (item) {
    items = [{ variantId: item.variantId, offerId: item.offerId, quantity: item.quantity || 1 }];
  } else {
    throw new AppError(
      'CART_TOKEN_OR_ITEM_REQUIRED',
      'Send an X-Cart-Token header, or a single `item` in the body for a "Buy Now" checkout',
      400
    );
  }

  const { order, items: orderItems } = await orderService.createOrder(
    req.tenant.workspaceId,
    { ...orderBody, items },
    req
  );

  if (cart) await cartService.markConverted(cart.id, order.id);

  // createOrder has committed by now (no outer transaction here), and
  // convertAfterOrder never throws: a conversion failure is logged, and the
  // shopper still gets the order they placed.
  await checkoutSessionService.convertAfterOrder(req.tenant.workspaceId, order, { checkoutSessionId });

  res.status(201).json({ order: { ...order.toJSON(), items: orderItems } });
});

module.exports = { checkout };
