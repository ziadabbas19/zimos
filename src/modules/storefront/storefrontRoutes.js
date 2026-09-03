'use strict';
const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { idempotent } = require('../../core/middleware/idempotency');
const controller = require('./storefrontController');
const cartController = require('../cart/cartController');
const checkoutController = require('../checkout/checkoutController');
const reviewController = require('../reviews/reviewController');
const reviewSchemas = require('../reviews/reviewValidation');
const schemas = require('./storefrontValidation');
const checkoutSchemas = require('../checkout/checkoutValidation');

const router = Router({ mergeParams: true });
router.use(resolvePublicWorkspace);

router.get('/', validate(schemas.workspaceParam), controller.getStore);
router.get('/products', validate(schemas.listProducts), controller.listProducts);
router.get('/products/:idOrSlug', validate(schemas.getProduct), controller.getProduct);
router.post('/products/:productId/reviews', validate(reviewSchemas.submit), reviewController.submit);
router.get('/collections', validate(schemas.workspaceParam), controller.listCollections);
router.get('/collections/:collectionId', validate(schemas.getCollection), controller.getCollection);

router.post(
  '/checkout',
  validate(checkoutSchemas.checkout),
  idempotent('storefront.checkout')(checkoutController.checkout)
);

module.exports = router;
