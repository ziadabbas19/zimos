'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { idempotent } = require('../../core/middleware/idempotency');
const { trackingLimiter } = require('../../core/middleware/rateLimiters');
const controller = require('./storefrontController');
const cartController = require('../cart/cartController');
const checkoutController = require('../checkout/checkoutController');
const reviewController = require('../reviews/reviewController');
const reviewSchemas = require('../reviews/reviewValidation');
const schemas = require('./storefrontValidation');
const checkoutSchemas = require('../checkout/checkoutValidation');
const checkoutSessionController = require('../checkoutSessions/checkoutSessionController');
const checkoutSessionSchemas = require('../checkoutSessions/checkoutSessionValidation');
const onlinePaymentController = require('../payments/onlinePaymentController');
const onlinePaymentSchemas = require('../payments/onlinePaymentValidation');

const router = Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

router.get('/', validate(schemas.workspaceParam), controller.getStore);
router.get('/products', validate(schemas.listProducts), controller.listProducts);
router.get('/products/:idOrSlug', validate(schemas.getProduct), controller.getProduct);
router.post('/products/:productId/reviews', validate(reviewSchemas.submit), reviewController.submit);
router.get('/collections', validate(schemas.workspaceParam), controller.listCollections);
router.get('/collections/:collectionId', validate(schemas.getCollection), controller.getCollection);

// Shopper order lookup. The limiter runs ahead of `validate` so a request that
// can't pass validation never reaches the database; it keys on the phone and
// order number, not the IP (see rateLimiters.js).
router.get('/orders/track', trackingLimiter, validate(schemas.track), controller.trackOrder);

// Checkout-form autosave for abandoned-checkout recovery. An upsert keyed on
// the visitor, so a replay is harmless and it takes no Idempotency-Key.
router.post('/checkout-sessions', validate(checkoutSessionSchemas.capture), checkoutSessionController.capture);

// Read-only: prices the shipping line the checkout would get.
router.post('/shipping-quote', validate(schemas.shippingQuote), controller.shippingQuote);

// The payment methods the checkout offers (COD only while online payments
// are off). A valid X-Store-Preview header adds test-mode gateway methods.
router.get('/payment-methods', validate(onlinePaymentSchemas.storeMethods), onlinePaymentController.storefrontMethods);

// An unpaid online order, for the shopper holding its X-Payment-Token (given
// once, by the checkout that created the order).
router.get('/orders/:orderId/payment', validate(onlinePaymentSchemas.shopperStatus), onlinePaymentController.shopperStatus);
router.post('/orders/:orderId/payment/return', validate(onlinePaymentSchemas.shopperReturn), onlinePaymentController.shopperReturn);
router.post('/orders/:orderId/payment/retry', validate(onlinePaymentSchemas.shopperRetry), onlinePaymentController.shopperRetry);
router.post(
  '/orders/:orderId/payment/switch-to-cod',
  validate(onlinePaymentSchemas.shopperAction),
  onlinePaymentController.shopperSwitchToCod
);

router.post(
  '/checkout',
  validate(checkoutSchemas.checkout),
  idempotent('storefront.checkout')(checkoutController.checkout)
);

module.exports = router;
