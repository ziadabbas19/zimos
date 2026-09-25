'use strict';
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const cartService = require('../cart/cartService');
const orderService = require('../orders/orderService');
const { afterOrderCompleted } = require('../orders/orderCompletion');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { assertRequiredCheckoutFields } = require('./checkoutSettings');
const methodsService = require('../payments/paymentMethodsService');
const online = require('../payments/onlinePaymentService');

/**
 * Guest checkout (no login). Runs the same orderService.createOrder as the
 * staff API. Two ways in: an `X-Cart-Token` header builds the order from that
 * cart's lines, or — with no token — a single `item` in the body ("Buy now")
 * goes straight to an order with no cart. The cart wins if both are given.
 *
 * Cash on delivery places the order as a sale at once (201 { order }).
 *
 * 'card' / 'wallet' (only with PAYMENTS_ONLINE_ENABLED) place it unpaid and
 * start a payment with the store's gateway: 201 { order, payment,
 * paymentToken }. `payment.redirectUrl` is where to send the shopper;
 * `paymentToken` is shown once and is what the shopper's browser uses for the
 * status / retry / switch-to-COD endpoints. A gateway that could not start the
 * payment still answers 201 with payment.status 'failed', so the shopper can
 * retry or switch to cash on delivery on the order that now exists.
 */
const checkout = asyncHandler(async (req, res) => {
  const cartToken = req.headers['x-cart-token'];
  const { item, checkoutSessionId, paymentProvider, returnUrl, ...orderBody } = req.body;
  const workspace = req.publicWorkspace;
  const workspaceId = req.tenant.workspaceId;

  // Per-store required fields (settings.checkout_settings). Checked before any
  // cart work so a rejected checkout costs nothing.
  assertRequiredCheckoutFields(workspace, req.body);

  const isOnline = orderBody.paymentMethod !== 'cod';
  if (isOnline && !env.payments.onlineEnabled) {
    // Exactly the refusal the COD-only checkout has always given.
    throw new ValidationError([{ field: 'paymentMethod', message: '"paymentMethod" must be [cod]' }], 'Invalid body');
  }

  let prepared = null;
  if (isOnline) {
    prepared = await online.prepareOnlineCheckout(workspace, { ...orderBody, paymentProvider, returnUrl }, req);
  } else if (env.payments.onlineEnabled) {
    // The merchant may have switched cash on delivery off.
    await methodsService.resolveStorefrontMethod(workspace, { paymentMethod: 'cod' }, {
      preview: methodsService.isPreviewRequest(req, workspaceId),
    });
  }

  let items;
  let cart = null;

  if (cartToken) {
    cart = await require('../../db/models').Cart.findOne({
      where: { workspaceId, guestToken: cartToken, status: 'active' },
    });
    if (!cart) throw new AppError('CART_NOT_FOUND', 'No active cart found for this token', 404);
    ({ items } = await cartService.toOrderItems(workspaceId, cart.id));
  } else if (item) {
    items = [{ variantId: item.variantId, offerId: item.offerId, quantity: item.quantity || 1 }];
  } else {
    throw new AppError(
      'CART_TOKEN_OR_ITEM_REQUIRED',
      'Send an X-Cart-Token header, or a single `item` in the body for a "Buy Now" checkout',
      400
    );
  }

  // Stock held by overdue unpaid online orders goes back first.
  await online.expireOverdueHolding(workspaceId, [...new Set(items.map((i) => i.variantId).filter(Boolean))]);

  const context = { cartId: cart ? cart.id : null, checkoutSessionId: checkoutSessionId || null };

  if (!isOnline) {
    const { order, items: orderItems } = await orderService.createOrder(workspaceId, { ...orderBody, items }, req);
    // createOrder has committed by now (no outer transaction here), and this
    // never throws: a conversion failure is logged, and the shopper still gets
    // the order they placed.
    await afterOrderCompleted(workspaceId, order, context);
    return res.status(201).json({ order: { ...order.toJSON(), items: orderItems } });
  }

  const { order, items: orderItems } = await orderService.createOrder(
    workspaceId,
    { ...orderBody, paymentMethod: prepared.method.method, items },
    req,
    {
      awaitingPayment: {
        expiresAt: prepared.expiresAt,
        tokenHash: prepared.tokenHash,
        completionContext: context,
      },
    }
  );

  const attempt = await online.startAttempt(order, {
    provider: prepared.method.provider,
    method: prepared.method.method,
    returnUrl: prepared.returnUrl,
  });

  res.status(201).json({
    order: { ...order.toJSON(), items: orderItems },
    payment: {
      id: attempt.id,
      status: attempt.status,
      provider: attempt.providerCode,
      method: attempt.method,
      mode: attempt.mode,
      redirectUrl: attempt.status === 'initialized' ? attempt.redirectUrl : null,
      failureReason: attempt.status === 'failed' ? attempt.failureReason : null,
      expiresAt: order.paymentExpiresAt,
    },
    paymentToken: prepared.token,
  });
});

module.exports = { checkout };
