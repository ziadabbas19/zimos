'use strict';
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const { storeFeatureOn } = require('../../core/middleware/storeFeatures');
const cartService = require('../cart/cartService');
const orderService = require('../orders/orderService');
const { afterOrderCompleted } = require('../orders/orderCompletion');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { assertRequiredCheckoutFields } = require('./checkoutSettings');
const { MAX_LINE_QUANTITY } = require('./checkoutValidation');
const { saveCheckoutAnswers } = require('./checkoutForm');
const methodsService = require('../payments/paymentMethodsService');
const { readVisitorId } = require('../customerUploads/customerUploadService');
const online = require('../payments/onlinePaymentService');
const manualPayments = require('../manualPayments/manualPaymentService');
const { resolveOrderBumpItem } = require('./orderBump');
const { offerWindowEnd } = require('../funnels/funnelOfferMerge');
const productTests = require('../catalog/productTests');
const logger = require('../../core/utils/logger');
// The checkout answer leaves out what the store knows about the phone or visitor (risk, IP, cost).
const { shopperOrder } = require('./shopperOrder');

/** Credits the order to the shopper's variant in its products' A/B tests; never fails the checkout. */
async function creditProductTests(workspaceId, orderItems, visitorId, orderId) {
  if (!visitorId) return;
  try {
    await productTests.recordOrder(workspaceId, (orderItems || []).map((i) => i.productId).filter(Boolean), visitorId, orderId);
  } catch (err) {
    logger.warn('Product test order could not be recorded', { error: err.message });
  }
}

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
  const { item, extraItems, orderBumps, checkoutSessionId, paymentProvider, returnUrl, orderBump, formFields, manualPaymentMethodId, gift, giftCardCode: cardCode, useStoreCredit, loyaltyPoints, referralCode, ...orderBody } = req.body;
  const workspace = req.publicWorkspace;
  const workspaceId = req.tenant.workspaceId;

  // A store on a "pause" holiday takes no orders (modules/holidayMode).
  require('../holidayMode').assertOpen(workspace);
  // Per-store required fields (settings.checkout_settings). Checked before any
  // cart work so a rejected checkout costs nothing.
  // A pickup order has no address, so the form's address rules do not apply to it.
  assertRequiredCheckoutFields(workspace, req.body.deliveryMethod === 'pickup' ? { ...req.body, shippingAddress: undefined } : req.body);

  // One of the store's manual methods: placed like cash on delivery, unpaid,
  // with a token the shopper's browser uses to send the transfer proof.
  const manualMethod =
    orderBody.paymentMethod === manualPayments.MANUAL_ORDER_METHOD
      ? await manualPayments.resolveForCheckout(workspaceId, manualPaymentMethodId)
      : null;
  const manualToken = manualMethod ? online.newPaymentToken() : null;
  const isOnline = orderBody.paymentMethod !== 'cod' && !manualMethod;
  // A gift card lowers what the courier collects (modules/giftCards): cash on delivery only. Off, the code is ignored.
  const giftCardCode = cardCode && storeFeatureOn('gift_cards') ? cardCode : null;
  if (giftCardCode) {
    if (orderBody.paymentMethod !== 'cod') throw new ValidationError([{ field: 'giftCardCode', message: 'A gift card can be used with cash on delivery' }], 'Invalid body');
    await require('../giftCards/giftCardService').assertUsable(workspaceId, giftCardCode, null);
  }
  // Loyalty points, only a signed-in shopper's, checked now and taken once the order exists; cash on delivery only (modules/loyalty). Off, ignored.
  let pointsOwner = null;
  if (loyaltyPoints && storeFeatureOn('loyalty')) {
    if (orderBody.paymentMethod !== 'cod') throw new ValidationError([{ field: 'loyaltyPoints', message: 'Points can be used with cash on delivery' }], 'Invalid body');
    const shopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, req.headers['x-shopper-token']);
    // The device id (risk/botProtection's guardCheckout) is for the loyalty guard's one-device rule.
    pointsOwner = await require('../loyalty/loyaltyService').assertCanSpend(workspace, shopper, loyaltyPoints, { deviceId: req.deviceId || null });
  }
  // Store credit, only a signed-in shopper's, cash on delivery only (modules/storeCredit). Off, ignored.
  let creditOwner = null;
  if (useStoreCredit && storeFeatureOn('store_credit')) {
    if (orderBody.paymentMethod !== 'cod') throw new ValidationError([{ field: 'useStoreCredit', message: 'Store credit can be used with cash on delivery' }], 'Invalid body');
    const shopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, req.headers['x-shopper-token']);
    creditOwner = await require('../storeCredit/storeCreditService').assertCanSpend(workspace, shopper);
  }
  if (isOnline && !env.payments.onlineEnabled) {
    // Exactly the refusal the COD-only checkout has always given.
    throw new ValidationError([{ field: 'paymentMethod', message: '"paymentMethod" must be [cod]' }], 'Invalid body');
  }

  let prepared = null;
  if (isOnline) {
    prepared = await online.prepareOnlineCheckout(workspace, { ...orderBody, paymentProvider, returnUrl }, req);
  } else if (env.payments.onlineEnabled && !manualMethod) {
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
    // Adding the same product again adds to its line, so a cart line can grow past what one add allows.
    if (items.some((line) => Number(line.quantity) > MAX_LINE_QUANTITY)) {
      throw new ValidationError(
        [{ field: 'items.quantity', message: `At most ${MAX_LINE_QUANTITY} of one item per order` }],
        `At most ${MAX_LINE_QUANTITY} of one item per order`
      );
    }
  } else if (item) {
    items = [item, ...(extraItems || [])].map((line) => ({
      variantId: line.variantId,
      offerId: line.offerId,
      quantity: line.quantity || 1,
      customizations: line.customizations,
      options: line.options,
    }));
  } else {
    throw new AppError(
      'CART_TOKEN_OR_ITEM_REQUIRED',
      'Send an X-Cart-Token header, or a single `item` in the body for a "Buy Now" checkout',
      400
    );
  }
  // A funnel's checkout prices the funnel's way (shipping, coupons, payment methods): the
  // funnel must be a published one of this store that sells these lines (funnels/funnelCheckout.js).
  await require('../funnels/funnelCheckout').assertSells(workspaceId, orderBody.funnelId, items);

  // The ticked order bump becomes one more line of this order, built by the
  // server from the configured offer (422 when it is not that offer).
  if (orderBump) {
    items = [...items, await resolveOrderBumpItem(workspace, { offerId: orderBump.offerId, funnelId: orderBody.funnelId })];
  }

  // The product's own bumps: lines built by the server from the rules of the products being bought.
  if (orderBumps && orderBumps.length > 0) {
    const bumpItems = await require('../offers/offerRules').resolveBumpItems(workspace, orderBumps.map((b) => b.offerId), items);
    items = [...items, ...bumpItems.filter((b) => !items.some((i) => i.offerId === b.offerId))];
  }

  // A product A/B test: plain lines at the price their shopper was shown — the
  // cart's (whoever filled it) or this visitor's for a Buy Now. Funnels price their own way.
  const testVisitor = orderBody.funnelId ? null : (cart && cart.visitorId) || productTests.visitorOf(req);
  items = await productTests.pinPrices(workspaceId, items, testVisitor);
  // Each product's min / max per order and max per customer (catalog/purchaseLimits.js).
  await require('../catalog/purchaseLimits').assertWithin(workspaceId, items, orderBody.contact);
  // The signed-in shopper's VIP tier: a percent off plain lines and/or free shipping (modules/vipTiers). Not in funnels.
  if (!orderBody.funnelId && req.headers['x-shopper-token'] && storeFeatureOn('vip_tiers')) {
    const vipShopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, req.headers['x-shopper-token']);
    if (vipShopper) ({ items } = await require('../vipTiers').applyAtCheckout(workspace, items, vipShopper, orderBody));
  }
  // A friend's invite: their offer on a first order, never on the inviter's own phone/email/account (modules/customerReferrals).
  let referral = null;
  if (referralCode && storeFeatureOn('customer_referrals')) {
    const inviteShopper = await require('../shopperAccounts/shopperAuth').readToken(workspaceId, req.headers['x-shopper-token']);
    ({ items, referral } = await require('../customerReferrals').applyAtCheckout(workspace, items, referralCode, orderBody, inviteShopper));
  }
  // Gift wrap is a line of the merchant's wrap product; the message is kept on the order (modules/giftOptions).
  const giftChoice = await require('../giftOptions').prepare(workspace, gift);
  if (giftChoice && giftChoice.line) items = [...items, giftChoice.line];

  // Stock held by overdue unpaid online orders goes back first.
  await online.expireOverdueHolding(workspaceId, [...new Set(items.map((i) => i.variantId).filter(Boolean))]);

  const context = { cartId: cart ? cart.id : null, checkoutSessionId: checkoutSessionId || null };
  // The shopper's answers to custom fields are checked again here, required
  // ones enforced; photos must be this visitor's or in this cart.
  const customFields = {
    enforceRequired: true,
    visitorId: req.headers['x-visitor-id'] ? readVisitorId(req) : null,
    cartId: cart ? cart.id : null,
  };

  if (!isOnline) {
    const { order, items: orderItems } = await orderService.createOrder(workspaceId, { ...orderBody, items }, req, {
      customFields,
      // A funnel with offers after its checkout (and the store's
      // funnel_upsell_merge on): nobody confirms the order until the shopper
      // is past them, so an accepted offer can still join it.
      confirmationAvailableAt: await offerWindowEnd(workspace, orderBody.funnelId),
      manualPayment: manualMethod ? { method: manualMethod, tokenHash: manualToken.hash } : null,
    });
    // createOrder has committed by now (no outer transaction here), and this
    // never throws: a conversion failure is logged, and the shopper still gets
    // the order they placed.
    await saveCheckoutAnswers(order, workspace, formFields);
    await require('../giftOptions').recordOnOrder(order, giftChoice);
    await require('../customerReferrals').recordOnOrder(order, referral);
    await require('../holidayMode').markOrder(workspace, order);
    await creditProductTests(workspaceId, orderItems, testVisitor, order.id);
    await afterOrderCompleted(workspaceId, order, context);
    // The card pays what it can now, as a captured payment; a card spent meanwhile leaves the order as it is.
    const giftCard = giftCardCode ? await require('../giftCards/giftCardService').redeemOnOrder(order, giftCardCode, req) : null;
    // Then the store credit, on what is still due.
    const credit = creditOwner ? await require('../storeCredit/storeCreditService').spendOnOrder(order, creditOwner.id, { req }) : null;
    // Then the points.
    const points = pointsOwner ? await require('../loyalty/loyaltyService').spendOnOrder(order, pointsOwner.id, loyaltyPoints, { req }) : null;
    if ((giftCard && giftCard.applied) || (credit && credit.applied) || (points && points.applied)) await order.reload();
    if (manualMethod) {
      const manualPayment = await manualPayments.getForShopper(workspaceId, order.id, manualToken.token);
      return res.status(201).json({ order: shopperOrder(order, orderItems), manualPayment, paymentToken: manualToken.token });
    }
    return res.status(201).json({ order: shopperOrder(order, orderItems), ...(giftCard ? { giftCard } : {}), ...(credit ? { storeCredit: credit } : {}), ...(points ? { loyalty: points } : {}) });
  }

  const { order, items: orderItems } = await orderService.createOrder(
    workspaceId,
    { ...orderBody, paymentMethod: prepared.method.method, items },
    req,
    {
      customFields,
      awaitingPayment: {
        expiresAt: prepared.expiresAt,
        tokenHash: prepared.tokenHash,
        completionContext: context,
      },
    }
  );

  await saveCheckoutAnswers(order, workspace, formFields);
  await require('../giftOptions').recordOnOrder(order, giftChoice);
  await require('../customerReferrals').recordOnOrder(order, referral);
  await require('../holidayMode').markOrder(workspace, order);
  await creditProductTests(workspaceId, orderItems, testVisitor, order.id);

  const attempt = await online.startAttempt(order, {
    provider: prepared.method.provider,
    method: prepared.method.method,
    returnUrl: prepared.returnUrl,
  });

  res.status(201).json({
    order: shopperOrder(order, orderItems),
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
