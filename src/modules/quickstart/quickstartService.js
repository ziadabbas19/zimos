'use strict';

const db = require('../../db/models');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/errors/AppError');
const { scoped } = require('../../core/utils/scopedRepository');
const pagesService = require('../pages/pagesService');
const catalogService = require('../catalog/catalogService');
const inventoryService = require('../inventory/inventoryService');
const orderService = require('../orders/orderService');
const storefrontService = require('../storefront/storefrontService');
const { recordAudit } = require('../audit/auditService');
const { formatMoney, parsePriceToMinor, parseBullets, storeHomeTree } = require('./quickstartAdapter');

/**
 * Turns the simple merchant forms into a live, multi-product store using the
 * catalog / inventory / pages / orders services — nothing here bypasses their
 * validation or transactions.
 *
 *  - addProduct    : createProduct + createVariant + createOffer + restock,
 *                    then regenerate & publish the store "/" page.
 *  - updateBranding : patch Workspace name / logoUrl / tagline / themeSettings.
 *
 * The store "/" page always lists all active products, not just the last one.
 */

const DEFAULT_STOCK = 100;

// --- merchant: add a product ------------------------------------------------

async function addProduct(workspaceId, input, req) {
  const priceMinor = parsePriceToMinor(input.price);
  if (!priceMinor) {
    throw new ValidationError(
      [{ field: 'price', message: 'Enter a valid price greater than 0' }],
      'Enter a valid price greater than 0'
    );
  }

  const currency = input.currency || 'EGP';
  const bullets = parseBullets(input.bullets);
  const imageUrl = input.imageUrl || '';

  // 1. Catalog — product + variant + a default fixed-price offer.
  const product = await catalogService.createProduct(
    workspaceId,
    {
      name: input.productName,
      description: input.description || '',
      status: 'active',
      media: imageUrl ? [{ type: 'image', url: imageUrl }] : [],
      seo: { bullets, image: imageUrl || undefined },
    },
    req
  );

  const variant = await catalogService.createVariant(
    workspaceId,
    product.id,
    { priceAmount: priceMinor, currency, allowOverselling: true },
    req
  );

  const stock = Number.isInteger(input.stock) && input.stock > 0 ? input.stock : DEFAULT_STOCK;
  await inventoryService.restock({
    workspaceId,
    variantId: variant.id,
    quantity: stock,
    reason: 'Quickstart initial stock',
    actorUserId: req.user.id,
  });

  await catalogService.createOffer(
    workspaceId,
    product.id,
    {
      name: `${input.productName} — standard`,
      pricingMode: 'fixed',
      priceAmount: priceMinor,
      currency,
      isDefault: true,
      lines: [{ variantId: variant.id, quantity: 1 }],
    },
    req
  );

  // 2. (Re)generate the store "/" page listing every active product.
  await regenerateStorePage(workspaceId, req);

  return { productId: product.id, variantId: variant.id };
}

// --- merchant: branding ---------------------------------------------------

async function updateBranding(workspaceId, patch, req) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');

  const before = {
    name: workspace.name,
    logoUrl: workspace.logoUrl,
    tagline: workspace.tagline,
    themeSettings: workspace.themeSettings,
  };
  const next = {};
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.logoUrl !== undefined) next.logoUrl = patch.logoUrl || null;
  if (patch.tagline !== undefined) next.tagline = patch.tagline || null;
  if (patch.themeSettings !== undefined) {
    const blob = patch.themeSettings || {};
    if (JSON.stringify(blob).length > 5000) {
      throw new ValidationError(
        [{ field: 'themeSettings', message: 'themeSettings is too large (max ~5KB)' }],
        'themeSettings is too large'
      );
    }
    next.themeSettings = blob; // opaque — stored as-is, never interpreted
  }
  await workspace.update(next);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'workspace.branding.update',
    entityType: 'Workspace',
    entityId: workspaceId,
    before,
    after: {
      name: workspace.name,
      logoUrl: workspace.logoUrl,
      tagline: workspace.tagline,
      themeSettings: workspace.themeSettings,
    },
    req,
  });
  return workspace;
}

// --- store page generation ----------------------------------------------

async function regenerateStorePage(workspaceId, req) {
  const workspace = await db.Workspace.findByPk(workspaceId);

  let website = await db.Website.findOne({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  if (!website) ({ website } = await pagesService.createWebsite(workspaceId, { name: workspace.name }, req));

  const tree = storeHomeTree(workspace.name);
  const seo = { title: workspace.name, _store: { storeName: workspace.name, regeneratedAt: new Date().toISOString() } };

  const page = await db.WebsitePage.findOne({ where: { workspaceId, websiteId: website.id, path: '/' } });
  if (page) {
    await pagesService.updatePage(workspaceId, website.id, page.id, { title: workspace.name, draftData: tree, seo }, req);
  } else {
    await pagesService.createPage(
      workspaceId,
      website.id,
      { path: '/', title: workspace.name, pageType: 'home', draftData: tree, seo },
      req
    );
  }
  await pagesService.publishWebsite(workspaceId, website.id, req.user.id, 'quickstart store update', req);
  return website;
}

// --- merchant: "my store" view data -----------------------------------

async function getMerchantStore(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  const { products } = await catalogService.listProducts(workspaceId, { limit: 200 });
  return {
    workspace,
    products: products.map((p) => {
      const v = (p.variants || [])[0];
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        priceLabel: v ? formatMoney(v.priceAmount, v.currency) : '—',
        variantCount: (p.variants || []).length,
      };
    }),
  };
}

// --- public store rendering data -------------------------------------

/** Throws NotFoundError('Store') if the workspace has no published storefront. */
async function assertPublishedStore(workspaceId) {
  const result = await pagesService.getPublishedPageForStore(workspaceId, '/');
  if (result.kind !== 'page') throw new NotFoundError('Store');
}

function productCardImage(p) {
  if (Array.isArray(p.media) && p.media[0]) return p.media[0].url || p.media[0].src || '';
  if (p.seo && p.seo.image) return p.seo.image;
  return '';
}

function productPriceMinor(p) {
  const offer = (p.offers || []).find((o) => o.isDefault) || (p.offers || [])[0];
  if (offer && offer.priceAmount != null) return offer.priceAmount;
  const v = (p.variants || [])[0];
  return v ? v.priceAmount : 0;
}
function productCurrency(p) {
  const v = (p.variants || [])[0];
  return (v && v.currency) || ((p.offers || [])[0] && p.offers[0].currency) || 'EGP';
}

async function storeHomeLocals(workspaceId) {
  await assertPublishedStore(workspaceId);
  const workspace = await db.Workspace.findByPk(workspaceId);
  const { products } = await storefrontService.listProducts(workspaceId, { limit: 100 });
  return {
    title: workspace.name,
    workspace: { name: workspace.name, logoUrl: workspace.logoUrl, tagline: workspace.tagline },
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      imageUrl: productCardImage(p),
      priceLabel: formatMoney(productPriceMinor(p), productCurrency(p)),
    })),
    productBase: `/shop/${workspaceId}/products`,
  };
}

async function productDetailLocals(workspaceId, productId) {
  await assertPublishedStore(workspaceId);
  const workspace = await db.Workspace.findByPk(workspaceId);
  let product;
  try {
    product = await storefrontService.getProductBySlugOrId(workspaceId, productId);
  } catch (err) {
    throw new NotFoundError('Product');
  }
  return {
    title: `${product.name} — ${workspace.name}`,
    workspace: { name: workspace.name, logoUrl: workspace.logoUrl, tagline: workspace.tagline },
    product: {
      id: product.id,
      name: product.name,
      description: product.description || '',
      imageUrl: productCardImage(product),
      bullets: (product.seo && product.seo.bullets) || [],
      priceLabel: formatMoney(productPriceMinor(product), productCurrency(product)),
    },
    homeUrl: `/shop/${workspaceId}`,
    checkoutUrl: `/shop/${workspaceId}/checkout?productId=${product.id}`,
  };
}

// --- public checkout --------------------------------------------------

/** Resolve which variant a public checkout is buying (1 unit). */
async function resolveCheckoutVariant(workspaceId, productId) {
  if (productId) {
    let product;
    try {
      product = await storefrontService.getProductBySlugOrId(workspaceId, productId);
    } catch (err) {
      throw new ValidationError([{ field: 'productId', message: 'Unknown product' }], 'Unknown product');
    }
    const v = (product.variants || [])[0];
    if (!v) throw new ValidationError([{ field: 'productId', message: 'Product has no purchasable variant' }]);
    return { product, variantId: v.id };
  }

  const { products } = await storefrontService.listProducts(workspaceId, { limit: 3 });
  if (products.length === 0) {
    throw new ValidationError([{ field: 'store', message: 'This store has no products yet' }]);
  }
  if (products.length > 1) {
    throw new ValidationError(
      [{ field: 'productId', message: 'This store has several products — choose one first' }],
      'Choose a product first'
    );
  }
  const v = (products[0].variants || [])[0];
  if (!v) throw new ValidationError([{ field: 'store', message: 'Product has no purchasable variant' }]);
  return { product: products[0], variantId: v.id };
}

async function checkoutLocals(workspaceId, productId) {
  await assertPublishedStore(workspaceId);
  const { product } = await resolveCheckoutVariant(workspaceId, productId);
  return {
    product: {
      id: product.id,
      name: product.name,
      priceLabel: formatMoney(productPriceMinor(product), productCurrency(product)),
    },
    actionUrl: `/shop/${workspaceId}/checkout`,
  };
}

async function placeSimpleOrder(workspaceId, form, req) {
  const { variantId } = await resolveCheckoutVariant(workspaceId, form.productId);
  const { order } = await orderService.createOrder(
    workspaceId,
    {
      items: [{ variantId, quantity: 1 }],
      contact: { fullName: form.fullName, phone: form.phone },
      shippingAddress: { country: form.country || 'EG', city: form.city, addressLine: form.addressLine },
      paymentMethod: 'cod',
    },
    req
  );
  return order;
}

async function getOrderForThankYou(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId } });
  if (!order) throw new NotFoundError('Order');
  const workspace = await db.Workspace.findByPk(workspaceId);
  return { order, storeName: workspace ? workspace.name : 'Store' };
}

async function hasAnyProduct(workspaceId) {
  const n = await scoped(db.Product, workspaceId).count();
  return n > 0;
}

module.exports = {
  addProduct,
  updateBranding,
  getMerchantStore,
  hasAnyProduct,
  storeHomeLocals,
  productDetailLocals,
  checkoutLocals,
  placeSimpleOrder,
  getOrderForThankYou,
};
