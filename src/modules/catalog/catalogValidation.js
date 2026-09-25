'use strict';

const Joi = require('joi');
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
  options: Joi.array().items(Joi.object({ name: Joi.string().required(), values: Joi.array().items(Joi.string()) })),
  media: Joi.array().items(Joi.object()),
  tags: Joi.array().items(Joi.string()),
  seo: Joi.object(),
  websiteId: uuid,
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

const productList = {
  params: Joi.object({ workspaceId: uuid.required() }),
  query: Joi.object({
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
    currency: Joi.string().length(3).default('EGP'),
    allowOverselling: Joi.boolean().default(false),
    weightGrams: weightGrams.optional(),
    dimensions: dimensions.optional(),
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
    allowOverselling: Joi.boolean().optional(),
    weightGrams: weightGrams.optional(),
    dimensions: dimensions.optional(),
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
    currency: Joi.string().length(3).default('EGP'),
    badge: Joi.string().max(100).allow(null, '').optional(),
    isDefault: Joi.boolean().default(false),
    shippingOverride: Joi.object().allow(null).optional(),
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
    status: Joi.string().valid('active', 'archived').optional(),
    lines: Joi.array()
      .items(Joi.object({ variantId: uuid.required(), quantity: Joi.number().integer().min(1).required() }))
      .min(1)
      .optional(),
  }).min(1),
};

const collection = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    name: Joi.string().min(1).max(200).required(),
    slug: Joi.string().max(200).optional(),
    description: Joi.string().allow('').optional(),
    rules: Joi.object().allow(null).optional(),
    seo: Joi.object().default({}),
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
    seo: Joi.object().optional(),
  }).min(1),
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
  productList,
  variant,
  variantGet,
  variantUpdate,
  variantDelete,
  offer,
  offerList,
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
};
