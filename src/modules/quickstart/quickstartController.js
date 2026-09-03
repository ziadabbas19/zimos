'use strict';

const asyncHandler = require('express-async-handler');
const { AppError } = require('../../core/errors/AppError');
const service = require('./quickstartService');
const { formatMoney } = require('./quickstartAdapter');

function basePath(req) {
  return req.originalUrl.split('?')[0];
}
function tokenOf(req) {
  return (req.body && req.body.token) || req.query.token || '';
}

// --- merchant (authenticated) -------------------------------------------

const showForm = asyncHandler(async (req, res) => {
  const wid = req.tenant.workspaceId;
  const wantAddForm = req.query.add === '1' || !(await service.hasAnyProduct(wid));

  if (wantAddForm) {
    return res.render('merchant-form', {
      title: 'Add a product',
      actionUrl: basePath(req),
      token: tokenOf(req),
      existing: {},
      error: null,
    });
  }

  const { workspace, products } = await service.getMerchantStore(wid);
  res.render('merchant-store', {
    title: `${workspace.name} — my store`,
    base: basePath(req),
    token: tokenOf(req),
    workspace,
    products,
    publicUrl: `/shop/${wid}`,
    notice: req.query.saved ? 'Saved.' : null,
    error: null,
  });
});

const submitForm = asyncHandler(async (req, res) => {
  try {
    await service.addProduct(req.tenant.workspaceId, req.body, req);
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).render('merchant-form', {
        title: 'Add a product',
        actionUrl: basePath(req),
        token: tokenOf(req),
        existing: req.body,
        error: err.message,
      });
    }
    throw err;
  }
  res.render('merchant-done', {
    title: 'Product published',
    publicUrl: `/shop/${req.tenant.workspaceId}`,
    manageUrl: basePath(req) + (tokenOf(req) ? `?token=${tokenOf(req)}` : ''),
  });
});

// JSON branding + theme update.
const patchBranding = asyncHandler(async (req, res) => {
  const ws = await service.updateBranding(req.tenant.workspaceId, req.body, req);
  res.json({
    workspace: {
      id: ws.id,
      name: ws.name,
      logoUrl: ws.logoUrl,
      tagline: ws.tagline,
      themeSettings: ws.themeSettings || {},
    },
  });
});

const submitBranding = asyncHandler(async (req, res) => {
  try {
    await service.updateBranding(req.tenant.workspaceId, req.body, req);
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) {
      const { workspace, products } = await service.getMerchantStore(req.tenant.workspaceId);
      return res.status(err.statusCode).render('merchant-store', {
        title: `${workspace.name} — my store`,
        base: basePath(req).replace(/\/branding$/, ''),
        token: tokenOf(req),
        workspace,
        products,
        publicUrl: `/shop/${req.tenant.workspaceId}`,
        notice: null,
        error: err.message,
      });
    }
    throw err;
  }
  const back = basePath(req).replace(/\/branding$/, '');
  const t = tokenOf(req);
  res.redirect(303, `${back}?saved=1${t ? `&token=${t}` : ''}`);
});

// --- public /shop viewer ----------------------------------------------

const renderStoreHome = asyncHandler(async (req, res) => {
  res.render('store-home', await service.storeHomeLocals(req.params.workspaceId));
});

const renderProductDetail = asyncHandler(async (req, res) => {
  res.render('store-product', await service.productDetailLocals(req.params.workspaceId, req.params.productId));
});

const renderCheckout = asyncHandler(async (req, res) => {
  const locals = await service.checkoutLocals(req.params.workspaceId, req.query.productId);
  res.render('checkout', { title: `Checkout — ${locals.product.name}`, ...locals, form: {}, error: null });
});

const submitCheckout = asyncHandler(async (req, res) => {
  try {
    const order = await service.placeSimpleOrder(req.params.workspaceId, req.body, req);
    return res.redirect(303, `/shop/${req.params.workspaceId}/thanks/${order.id}`);
  } catch (err) {
    const status = err instanceof AppError && err.statusCode < 500 ? err.statusCode : 400;
    let locals;
    try {
      locals = await service.checkoutLocals(req.params.workspaceId, req.body.productId);
    } catch (e2) {
      locals = { product: { name: 'your order', priceLabel: '' }, actionUrl: `/shop/${req.params.workspaceId}/checkout` };
    }
    return res.status(status).render('checkout', {
      title: `Checkout — ${locals.product.name}`,
      ...locals,
      form: req.body,
      error: err.message || 'Could not place the order',
    });
  }
});

const renderThankYou = asyncHandler(async (req, res) => {
  const { order, storeName } = await service.getOrderForThankYou(req.params.workspaceId, req.params.orderId);
  res.render('thankyou', {
    title: 'Thank you',
    order,
    storeName,
    totalLabel: formatMoney(order.totalAmount, order.currency),
    homeUrl: `/shop/${req.params.workspaceId}`,
  });
});

module.exports = {
  showForm,
  submitForm,
  submitBranding,
  patchBranding,
  renderStoreHome,
  renderProductDetail,
  renderCheckout,
  submitCheckout,
  renderThankYou,
};
