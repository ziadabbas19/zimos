'use strict';
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

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
const workspaceIdParam = workspaceRef().required();

module.exports = {
  checkout: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    body: Joi.object({
      contact: contact.required(),
      shippingAddress: address.optional(),
      // Cash on delivery only, deliberately. No online gateway is connected
      // yet (see modules/payments/paymentService.js), so accepting 'card' /
      // 'wallet' / 'bank_transfer' here would place an order the shopper
      // believes is paid and that nothing ever charges. Re-enable them the
      // day a real gateway (Paymob) lands:
      //   .valid('cod', 'card', 'wallet', 'bank_transfer')
      // Staff order creation (orders/orderValidation.js) still accepts every
      // method — a merchant recording a bank transfer they received is real.
      paymentMethod: Joi.string().valid('cod').required(),
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
