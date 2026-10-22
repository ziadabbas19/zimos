'use strict';

const Joi = require('joi');
const { PRODUCT_SHIPPING_MODES } = require('../shipping/shippingRules');
const { customFieldsSchema } = require('./customFields');
const { optionSchema, productPageFields } = require('./productPage');

const uuid = Joi.string().uuid();

const productStatus = Joi.string().valid('draft', 'active', 'archived');

// Shipping weight in grams; null clears it ("no weight set"). 0 is a real
// weight. The cap matches shipping/shippingWeight.MAX_WEIGHT_GRAMS (1 t).
const weightGrams = Joi.number().integer().min(0).max(1000000).allow(null);
// Package dimensions in centimetres, all three or none.
const dimensions = Joi.object({
  lengthCm: Joi.number().positive().max(10000).required(),
  widthCm: Joi.number().positive().max(10000).required(),
  heightCm: Joi.number().positive().max(10000).required(),
}).allow(null);

// Field rules only, no defaults: defaults belong to create. A PATCH must
// leave every field it doesn't send untouched (a defaulted `status` would
// silently un-archive or un-publish, a defaulted `media` would wipe images).
const productFields = {
  name: Joi.string().min(1).max(300),
  slug: Joi.string().max(300),
  description: Joi.string().allow('').max(20000),
  productType: Joi.string().valid('physical', 'digital', 'service'),
  status: productStatus,
  options: Joi.array().items(optionSchema),
  media: Joi.array().items(Joi.object()),
  tags: Joi.array().items(Joi.string()),
  // The product page's search and sharing details (the storefront's metadata and sitemap read them).
  // Other keys are kept as they were sent, as before.
  seo: Joi.object({
    title: Joi.string().trim().max(120).allow('', null),
    description: Joi.string().trim().max(320).allow('', null),
    imageUrl: Joi.string().trim().max(1000).uri({ scheme: ['http', 'https'] }).allow('', null),
    noindex: Joi.boolean(),
  }).unknown(true),
  websiteId: uuid,
  // How the product ships (shipping/shippingRules.js). The extra fee is per
  // unit, minor units, and goes with shippingMode 'extra_fee' only — the
  // service checks the pair against what the product already has.
  shippingMode: Joi.string().valid(...PRODUCT_SHIPPING_MODES),
  shippingExtraAmount: Joi.number().integer().min(1).max(100000000).allow(null),
  // What the shopper fills in when ordering: at most five text / textarea /
  // image fields (catalog/customFields.js). Sent whole; [] removes them all.
  customFields: customFieldsSchema,
  // Priority, special offer line, external refs, page settings and content.
  ...productPageFields,
};

const product = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    ...productFields,
    name: productFields.name.required(),
    productType: productFields.productType.default('physical'),
    status: productFields.status.default('draft'),
    options: productFields.options.default([]),
    media: productFields.media.default([]),
    tags: productFields.tags.default([]),
    seo: productFields.seo.default({}),
    // Optional first variant, created with the product in one transaction so a
    // simple product is sellable (priced and stocked) straight away.
    variant: Joi.object({
      priceAmount: Joi.number().integer().min(0).required(),
      compareAtAmount: Joi.number().integer().min(0).allow(null).optional(),
      sku: Joi.string().max(100).allow(null, '').optional(),
      stockOnHand: Joi.number().integer().min(0).default(0),
      allowOverselling: Joi.boolean().default(false),
      weightGrams: weightGrams.optional(),
      dimensions: dimensions.optional(),
    }).optional(),
  }),
};

const variantImage = Joi.string().trim().uri({ scheme: ['http', 'https'] }).max(1000).allow('', null);

// No `variant` here: variants are edited through their own endpoints.
const productUpdate = {
  params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
  body: Joi.object(productFields),
};

const productGet = {
  params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
};

const productDelete = productGet;
const productRestore = productGet;
const productDeletePermanent = productGet;

// The staff product list's filters; the count and the bulk delete of every
// match (catalogBulkRoutes.js) take the same ones.
const productListFilters = {
  // One status, or several: "draft,active" (or a repeated ?status= param).
  status: Joi.alternatives()
    .try(
      productStatus,
      Joi.string()
        .pattern(/^(draft|active|archived)(,(draft|active|archived))+$/)
        .message('"status" must be draft, active, archived, or a comma-separated list of them'),
      Joi.array().items(productStatus).min(1)
    )
    .optional(),
  collectionId: uuid.optional(),
  // Name contains / a variant's SKU contains / type / can still be sold or not.
  q: Joi.string().trim().max(100).allow('').optional(),
  sku: Joi.string().trim().max(100).allow('').optional(),
  productType: Joi.string().valid('physical', 'digital', 'service').optional(),
  stock: Joi.string().valid('in', 'out').optional(),
};

const productList = {
  params: Joi.object({ workspaceId: uuid.required() }),
  query: Joi.object({
    ...productListFilters,
    limit: Joi.number().integer().min(1).max(200).default(50),
    cursor: uuid.optional(),
  }),
};

const variant = {
  params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
  body: Joi.object({
    sku: Joi.string().max(100).allow(null, '').optional(),
    barcode: Joi.string().max(100).allow(null, '').optional(),
    optionValues: Joi.object().default({}),
    priceAmount: Joi.number().integer().min(0).required(),
    compareAtAmount: Joi.number().integer().min(0).allow(null).optional(),
    costAmount: Joi.number().integer().min(0).allow(null).optional(),
    lowStockThreshold: Joi.number().integer().min(0).max(1000000).allow(null).optional(),
    // Unset: the store's own currency (currencies/baseCurrency.js).
    currency: Joi.string().length(3).uppercase().optional(),
    allowOverselling: Joi.boolean().default(false),
    weightGrams: weightGrams.optional(),
    dimensions: dimensions.optional(),
    // The variant's own picture (http/https), shown when it is chosen.
    imageUrl: variantImage.optional(),
    // Initial stock is set here at creation only; all later mutations go through /inventory endpoints.
    stockOnHand: Joi.number().integer().min(0).default(0),
  }),
};

const variantGet = {
  params: Joi.object({ workspaceId: uuid.required(), variantId: uuid.required() }),
};

const variantUpdate = {
  params: Joi.object({ workspaceId: uuid.required(), variantId: uuid.required() }),
  body: Joi.object({
    sku: Joi.string().max(100).allow(null, '').optional(),
    barcode: Joi.string().max(100).allow(null, '').optional(),
    priceAmount: Joi.number().integer().min(0).optional(),
    compareAtAmount: Joi.number().integer().min(0).allow(null).optional(),
    costAmount: Joi.number().integer().min(0).allow(null).optional(),
    lowStockThreshold: Joi.number().integer().min(0).max(1000000).allow(null).optional(),
    allowOverselling: Joi.boolean().optional(),
    weightGrams: weightGrams.optional(),
    dimensions: dimensions.optional(),
    imageUrl: variantImage.optional(),
    status: Joi.string().valid('active', 'archived').optional(),
  }),
};

const variantDelete = variantGet;

const offer = {
  params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
  body: Joi.object({
    name: Joi.string().min(1).max(200).required(),
    pricingMode: Joi.string().valid('fixed', 'computed').default('fixed'),
    priceAmount: Joi.number().integer().min(0).when('pricingMode', { is: 'fixed', then: Joi.required() }),
    // Unset: the store's own currency (currencies/baseCurrency.js).
    currency: Joi.string().length(3).uppercase().optional(),
    badge: Joi.string().max(100).allow(null, '').optional(),
    isDefault: Joi.boolean().default(false),
    shippingOverride: Joi.object().allow(null).optional(),
    // Minutes a shopper has to take it as a one-click offer (offers/offerCountdown.js); null = none.
    countdownMinutes: Joi.number().integer().min(1).max(1440).allow(null).optional(),
    lines: Joi.array()
      .items(Joi.object({ variantId: uuid.required(), quantity: Joi.number().integer().min(1).required() }))
      .min(1)
      .required(),
  }),
};

const offerParams = Joi.object({ workspaceId: uuid.required(), offerId: uuid.required() });

const offerList = {
  params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
};

const workspaceOfferList = {
  params: Joi.object({ workspaceId: uuid.required() }),
  query: Joi.object({
    // Matches the offer's or its product's name.
    q: Joi.string().trim().max(100).allow('').optional(),
    limit: Joi.number().integer().min(1).max(100).default(50),
  }),
};

const offerGet = { params: offerParams };
const offerDelete = { params: offerParams };

const offerUpdate = {
  params: offerParams,
  body: Joi.object({
    name: Joi.string().min(1).max(200).optional(),
    pricingMode: Joi.string().valid('fixed', 'computed').optional(),
    priceAmount: Joi.number().integer().min(0).allow(null).optional(),
    currency: Joi.string().length(3).optional(),
    badge: Joi.string().max(100).allow(null, '').optional(),
    isDefault: Joi.boolean().optional(),
    shippingOverride: Joi.object().allow(null).optional(),
    // Minutes a shopper has to take it as a one-click offer (offers/offerCountdown.js); null = none.
    countdownMinutes: Joi.number().integer().min(1).max(1440).allow(null).optional(),
    status: Joi.string().valid('active', 'archived').optional(),
    lines: Joi.array()
      .items(Joi.object({ variantId: uuid.required(), quantity: Joi.number().integer().min(1).required() }))
      .min(1)
      .optional(),
  }).min(1),
};

// A collection's picture: an http(s) URL, typically from the media library.
const collectionImage = Joi.string()
  .uri({ scheme: ['http', 'https'] })
  .max(1000)
  .allow('', null);
const collectionPosition = Joi.number().integer().min(0).max(100000);

const collection = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    name: Joi.string().min(1).max(200).required(),
    slug: Joi.string().max(200).optional(),
    description: Joi.string().allow('').optional(),
    rules: Joi.object().allow(null).optional(),
    // Same keys as a product's (title, description, imageUrl, noindex): the store's category page reads them.
    seo: productFields.seo.default({}),
    // Null (or absent) is a top-level collection.
    parentId: uuid.allow(null).optional(),
    // Absent puts it after its siblings.
    position: collectionPosition.optional(),
    imageUrl: collectionImage.optional(),
    showInHeader: Joi.boolean().optional(),
    hidden: Joi.boolean().optional(),
  }),
};

const collectionParams = Joi.object({ workspaceId: uuid.required(), collectionId: uuid.required() });

const collectionList = { params: Joi.object({ workspaceId: uuid.required() }) };
const collectionGet = { params: collectionParams };
const collectionDelete = { params: collectionParams };

const collectionUpdate = {
  params: collectionParams,
  body: Joi.object({
    name: Joi.string().min(1).max(200).optional(),
    slug: Joi.string().max(200).optional(),
    description: Joi.string().allow('').optional(),
    rules: Joi.object().allow(null).optional(),
    seo: productFields.seo.optional(),
    parentId: uuid.allow(null).optional(),
    position: collectionPosition.optional(),
    imageUrl: collectionImage.optional(),
    showInHeader: Joi.boolean().optional(),
    hidden: Joi.boolean().optional(),
  }).min(1),
};

const collectionReorder = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    items: Joi.array()
      .items(
        Joi.object({
          id: uuid.required(),
          // Leave out to keep the current parent; null moves it to the top level.
          parentId: uuid.allow(null).optional(),
          position: collectionPosition.optional(),
        })
      )
      .min(1)
      .max(500)
      .unique('id')
      .required(),
  }),
};

const collectionProductOrder = {
  params: collectionParams,
  body: Joi.object({
    productIds: Joi.array().items(uuid.required()).min(1).max(2000).unique().required(),
  }),
};

const addToCollection = {
  params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required(), collectionId: uuid.required() }),
};

const removeFromCollection = addToCollection;

module.exports = {
  product,
  productUpdate,
  productGet,
  productDelete,
  productRestore,
  productDeletePermanent,
  productListFilters,
  productList,
  variant,
  variantGet,
  variantUpdate,
  variantDelete,
  offer,
  offerList,
  workspaceOfferList,
  offerGet,
  offerUpdate,
  offerDelete,
  collection,
  collectionList,
  collectionGet,
  collectionUpdate,
  collectionDelete,
  addToCollection,
  removeFromCollection,
  collectionReorder,
  collectionProductOrder,
};
