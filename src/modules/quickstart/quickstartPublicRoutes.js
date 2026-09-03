'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const controller = require('./quickstartController');
const schemas = require('./quickstartValidation');

// Public storefront viewer at /shop/:workspaceId (also reached via a matched
// subdomain / custom domain through hostResolver). No staff auth.
const router = Router({ mergeParams: true });

router.use((req, res, next) => {
  res.removeHeader('Content-Security-Policy');
  next();
});
router.use(resolvePublicWorkspace);

router.get('/', validate(schemas.workspaceParam), controller.renderStoreHome);
router.get('/products/:productId', validate(schemas.productDetail), controller.renderProductDetail);
router.get('/checkout', validate(schemas.checkoutView), controller.renderCheckout);
router.post('/checkout', validate(schemas.checkout), controller.submitCheckout);
router.get('/thanks/:orderId', validate(schemas.thankYou), controller.renderThankYou);

module.exports = router;
