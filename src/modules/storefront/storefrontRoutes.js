'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace, refuseDraftOrders } = require('../../core/middleware/publicWorkspace');
const { idempotent } = require('../../core/middleware/idempotency');
const { trackingLimiter, suggestLimiter, uploadLimiter, manualProofLimiter, checkoutOtpLimiter, reviewLimiter } = require('../../core/middleware/rateLimiters');
const customerUploadController = require('../customerUploads/customerUploadController');
const { collectOptionFilters } = require('./optionFilters');
const controller = require('./storefrontController');
const reviewController = require('../reviews/reviewController');
const reviewSchemas = require('../reviews/reviewValidation');
const cartController = require('../cart/cartController');
const checkoutController = require('../checkout/checkoutController');
const schemas = require('./storefrontValidation');
const checkoutSchemas = require('../checkout/checkoutValidation');
const checkoutSessionController = require('../checkoutSessions/checkoutSessionController');
const checkoutSessionSchemas = require('../checkoutSessions/checkoutSessionValidation');
const onlinePaymentController = require('../payments/onlinePaymentController');
const onlinePaymentSchemas = require('../payments/onlinePaymentValidation');
const manualPaymentController = require('../manualPayments/manualPaymentController');
const manualPaymentSchemas = require('../manualPayments/manualPaymentValidation');
const botProtection = require('../risk/botProtection');
const checkoutOtp = require('../risk/checkoutOtp');
const lostOrders = require('../checkoutSessions/lostOrderService');
const lostOrderController = require('../checkoutSessions/lostOrderController');

const router = Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

// Order bumps, cross-sell, the thank-you upsell and the exit popup (modules/offers).
router.use(require('../offers/publicOfferRoutes'));

// What the checkout form needs to pass the bot guard (a fresh time token).
router.get('/checkout/guard', botProtection.guardConfig);
// The unsubscribe link in a marketing email (notifications/marketingUnsubscribe.js).
router.use(require('../notifications/marketingUnsubscribe').router);
// The code-entry step of a checkout that answered 428 OTP_REQUIRED.
// One per-IP budget a minute for both, on top of the per-code and per-phone limits.
router.post('/checkout/otp/verify', checkoutOtpLimiter, checkoutOtp.verify);
router.post('/checkout/otp/resend', checkoutOtpLimiter, checkoutOtp.resend);
// What a recovery link (/r/:token) rebuilds: the cart and the form.
router.get('/recover/:token', lostOrderController.recover);

router.get('/', validate(schemas.workspaceParam), controller.getStore);
router.get('/policies/:key', validate(schemas.getPolicy), controller.getPolicy);
router.get('/sitemap', validate(schemas.workspaceParam), controller.getSitemap);
router.get('/products', collectOptionFilters, validate(schemas.listProducts), controller.listProducts);
// Above '/products/:idOrSlug', so "suggest" is never read as a product slug.
router.get('/products/suggest', suggestLimiter, validate(schemas.suggest), controller.suggestProducts);
router.get('/products/:idOrSlug', validate(schemas.getProduct), controller.getProduct);
// Closed unless REVIEWS_PUBLIC_SUBMISSION_ENABLED (reviewController.submissionGate).
// A few a minute per address before anything is read; reviewService caps an hour too.
router.post('/products/:productId/reviews', reviewController.submissionGate, reviewLimiter, validate(reviewSchemas.submit), reviewController.submit);
// Reviews of the whole store: the published ones with the store's stars, and sending one (same gate).
router.get('/store-reviews', validate(reviewSchemas.storeList), reviewController.storeReviews);
router.post('/store-reviews', reviewController.submissionGate, reviewLimiter, validate(reviewSchemas.submitStore), reviewController.submitStore);
// A shopper's photo on a published review (private storage, served while the review shows it).
router.get('/review-photos/:uploadId', validate(reviewSchemas.photo), reviewController.photo);
// The combos a product's page shows (modules/combos, PRODUCT_COMBOS_ENABLED).
router.use(require('../combos/comboRoutes').store);
// A product page's A/B test: which variant this visitor sees (catalog/productTests.js).
router.use(require('../catalog/productTests').publicRouter);
router.get('/collections', validate(schemas.workspaceParam), controller.listCollections);
// A shopper's photo for a product's image field (customerUploads). Limited
// before multer reads a byte; multer refuses anything over 15 MB mid-stream.
router.post('/uploads', uploadLimiter, customerUploadController.acceptFile, customerUploadController.create);
router.get('/collections/:collectionId', validate(schemas.getCollection), controller.getCollection);

// Shopper order lookup. The limiter runs ahead of `validate` so a request that
// can't pass validation never reaches the database; it keys on the phone and
// order number, not the IP (see rateLimiters.js).
router.get('/orders/track', trackingLimiter, validate(schemas.track), controller.trackOrder);
// The signed link the store's messages carry; covered by the storefront limiter like every /store call.
router.get('/orders/track-link', validate(schemas.trackLink), controller.trackOrderByToken);

// Checkout-form autosave for abandoned-checkout recovery. An upsert keyed on
// the visitor, so a replay is harmless and it takes no Idempotency-Key.
router.post('/checkout-sessions', validate(checkoutSessionSchemas.capture), refuseDraftOrders, require('../checkoutSessions/autosaveGuard').guardAutosave, checkoutSessionController.capture);

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
// The store's manual methods (InstaPay, a wallet) and, for an order paid by
// one, the shopper's proof (X-Payment-Token): the number they paid from and a
// screenshot, limited per IP before multer reads a byte (modules/manualPayments).
router.get('/manual-payment-methods', validate(manualPaymentSchemas.storeMethods), manualPaymentController.storefrontMethods);
router.get('/orders/:orderId/manual-payment', validate(manualPaymentSchemas.shopperStatus), manualPaymentController.shopperStatus);
router.post(
  '/orders/:orderId/manual-payment/proof',
  manualProofLimiter,
  validate(manualPaymentSchemas.shopperStatus),
  customerUploadController.acceptFile,
  manualPaymentController.submitProof
);
router.post(
  '/orders/:orderId/payment/switch-to-cod',
  validate(onlinePaymentSchemas.shopperAction),
  onlinePaymentController.shopperSwitchToCod
);

// A draft store, reachable here only through a staff preview, sells nothing.
router.post(
  '/checkout',
  validate(checkoutSchemas.checkout),
  // Honeypot, time token, optional challenge — modules/risk/botProtection.
  botProtection.guardCheckout,
  refuseDraftOrders,
  // Phone verification, when the store asks for it — modules/risk/checkoutOtp.
  checkoutOtp.guardCheckout,
  idempotent('storefront.checkout')(checkoutController.checkout),
  // A refused checkout is kept as a lost order (checkoutSessions/lostOrderService).
  lostOrders.captureRefusal
);

module.exports = router;
