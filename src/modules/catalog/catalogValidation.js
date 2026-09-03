'use strict';

const Joi = require('joi');
const uuid = Joi.string().uuid();

const product = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    name: Joi.string().min(1).max(300).required(),
    slug: Joi.string().max(300).optional(),
    description: Joi.string().allow('').max(20000).optional(),
    productType: Joi.string().valid('physical', 'digital', 'service').default('physical'),
    status: Joi.string().valid('draft', 'active', 'archived').default('draft'),
    options: Joi.array().items(Joi.object({ name: Joi.string().required(), values: Joi.array().items(Joi.string()) })).default([]),
    media: Joi.array().items(Joi.object()).default([]),
    tags: Joi.array().items(Joi.string()).default([]),
    seo: Joi.object().default({}),
    websiteId: uuid.optional(),
  }),
};

const productUpdate = {
  params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
  body: product.body.fork(['name'], (s) => s.optional()),
};

const productGet = {
  params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
};

const productDelete = productGet;

const productList = {
  params: Joi.object({ workspaceId: uuid.required() }),
  query: Joi.object({
    status: Joi.string().valid('draft', 'active', 'archived').optional(),
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
    weightGrams: Joi.number().integer().min(0).allow(null).optional(),
    dimensions: Joi.object().allow(null).optional(),
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
