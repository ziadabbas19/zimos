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
      // 'card' / 'wallet' go through the store's connected gateway and are
      // refused unless PAYMENTS_ONLINE_ENABLED is on (see checkoutController):
      // with it off the checkout takes cash on delivery only, as it always
      // has. Staff order creation (orders/orderValidation.js) accepts every
      // method — a merchant recording a bank transfer they received is real.
      paymentMethod: Joi.string().valid('cod', 'card', 'wallet').required(),
      // Which gateway, when more than one offers the method. Optional.
      paymentProvider: Joi.string().max(50).optional(),
      // Where the gateway sends the shopper back to (online methods only).
      returnUrl: Joi.string().max(2000).optional(),
      discountCode: Joi.string().max(100).optional(),
      funnelId: uuid.optional(),
      websiteId: uuid.optional(),
      notes: Joi.string().max(2000).allow('').optional(),
      // The autosaved session (POST /checkout-sessions) this checkout came
      // from, converted once the order exists. Sessions with the same phone
      // are converted either way; this covers a changed phone. Deliberately
      // loose: it is a hint, and a malformed one must never cost the shopper
      // their order — the conversion step ignores anything it cannot use.
      checkoutSessionId: Joi.string().max(100).allow('', null).optional(),
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
