'use strict';
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');

const contact = Joi.object({
  fullName: Joi.string().max(200).required(),
  phone: Joi.string().max(32).required(),
  alternatePhone: Joi.string().max(32).allow(null, '').optional(),
  email: joiEmail().allow(null, '').optional(),
});

const address = Joi.object({
  country: Joi.string().length(2).required(),
  province: Joi.string().max(100).allow(null, '').optional(),
  city: Joi.string().max(100).required(),
  addressLine: Joi.string().max(500).required(),
  postalCode: Joi.string().max(20).allow(null, '').optional(),
  notes: Joi.string().max(500).allow(null, '').optional(),
});

const uuid = Joi.string().uuid();

module.exports = {
  checkout: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      contact: contact.required(),
      shippingAddress: address.optional(),
      paymentMethod: Joi.string().valid('cod', 'card', 'wallet', 'bank_transfer').required(),
      discountCode: Joi.string().max(100).optional(),
      funnelId: uuid.optional(),
      websiteId: uuid.optional(),
      notes: Joi.string().max(2000).allow('').optional(),
      // "Buy Now" — a single item straight to checkout, no cart. Ignored when
      // an X-Cart-Token header is present (the cart wins).
      item: Joi.object({
        variantId: uuid.required(),
        offerId: uuid.optional(),
        quantity: Joi.number().integer().min(1).default(1),
      }).optional(),
    }),
  },
};
