'use strict';

const Joi = require('joi');

const uuid = Joi.string().uuid();

// Add-a-product form (urlencoded).
const provision = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    token: Joi.string().optional().strip(), // flex-auth token, not persisted
    productName: Joi.string().min(1).max(200).required(),
    price: Joi.string().min(1).max(40).required(),
    currency: Joi.string().uppercase().length(3).default('EGP'),
    imageUrl: Joi.string().uri().allow('').max(1000).default(''),
    description: Joi.string().allow('').max(4000).default(''),
    bullets: Joi.string().allow('').max(4000).default(''),
    stock: Joi.number().integer().min(0).optional(),
  }),
};

// Branding form submit (urlencoded, EJS flow).
const branding = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    token: Joi.string().optional().strip(),
    name: Joi.string().min(2).max(200).optional(),
    logoUrl: Joi.string().uri().allow('').max(1000).optional(),
    tagline: Joi.string().allow('').max(300).optional(),
  }).min(1),
};

// Branding + theme update (JSON).
const brandingJson = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    name: Joi.string().min(2).max(200).optional(),
    logoUrl: Joi.string().uri().allow('', null).max(1000).optional(),
    tagline: Joi.string().allow('', null).max(300).optional(),
    // Opaque theme blob; light key cap here, ~5KB size cap in the service.
    themeSettings: Joi.object().unknown(true).max(50).optional(),
  }).min(1),
};

const workspaceParam = { params: Joi.object({ workspaceId: uuid.required() }) };

const productDetail = {
  params: Joi.object({ workspaceId: uuid.required(), productId: Joi.string().max(300).required() }),
};

const checkoutView = {
  params: Joi.object({ workspaceId: uuid.required() }),
  query: Joi.object({ productId: Joi.string().max(300).optional() }),
};

const checkout = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    productId: Joi.string().max(300).allow('').optional(),
    fullName: Joi.string().min(1).max(200).required(),
    phone: Joi.string().min(3).max(32).required(),
    addressLine: Joi.string().min(1).max(500).required(),
    city: Joi.string().min(1).max(100).required(),
    country: Joi.string().uppercase().length(2).default('EG'),
  }),
};

const thankYou = {
  params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
};

module.exports = { provision, branding, brandingJson, workspaceParam, productDetail, checkoutView, checkout, thankYou };
