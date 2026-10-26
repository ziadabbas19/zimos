'use strict';
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const { customizationsInputSchema } = require('../catalog/customFields');
const { formFieldsBodySchema } = require('./checkoutForm');
const { optionsInputSchema } = require('../catalog/menuOptions');

// Units of one line a shopper may order at once: no store sells more in one
// checkout, and one order asking for a product's whole stock holds it until
// the merchant cancels (as the shipping quote and the coupon preview cap it).
const MAX_LINE_QUANTITY = 1000;

const contact = Joi.object({
  fullName: Joi.string().max(200).required(),
  phone: Joi.string().max(32).required(),
  alternatePhone: Joi.string().max(32).allow(null, '').optional(),
  email: joiEmail().allow(null, '').optional(),
});

const address = Joi.object({
  country: Joi.string().length(2).required(),
  province: Joi.string().max(100).allow(null, '').optional(),
  // Required unless the store's purchase form switched them off — enforced
  // per store in checkoutForm.assertCheckoutForm.
  city: Joi.string().max(100).allow(null, '').optional(),
  addressLine: Joi.string().max(500).allow(null, '').optional(),
  postalCode: Joi.string().max(20).allow(null, '').optional(),
  notes: Joi.string().max(500).allow(null, '').optional(),
});

const uuid = Joi.string().uuid();
const workspaceIdParam = workspaceRef().required();

module.exports = {
  MAX_LINE_QUANTITY,
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
      paymentMethod: Joi.string().valid(...require('../payments/methodNames').STOREFRONT_METHODS, 'bank_transfer').required(),
      // 'bank_transfer' is one of the store's manual methods (InstaPay, a
      // wallet): which one, required with it and refused without it.
      manualPaymentMethodId: Joi.when('paymentMethod', { is: 'bank_transfer', then: uuid.required(), otherwise: Joi.forbidden() }),
      // Which gateway, when more than one offers the method. Optional.
      paymentProvider: Joi.string().max(50).optional(),
      // Where the gateway sends the shopper back to (online methods only).
      returnUrl: Joi.string().max(2000).optional(),
      discountCode: Joi.string().max(100).optional(),
      // The shipping option the shopper picked (shipping/shippingOptions.js); absent = standard.
      shippingOption: Joi.string().max(40).optional(),
      // 'pickup': collected from the store (shipping/storePickup.js) — no address, no shipping fee.
      deliveryMethod: Joi.string().valid('delivery', 'pickup').optional(),
      // The store's delivery area (shipping/deliveryZones.js) while it prices by zones.
      deliveryZoneId: uuid.optional(),
      funnelId: uuid.optional(),
      websiteId: uuid.optional(),
      notes: Joi.string().max(2000).allow('').optional(),
      // A gift card paying part or all of a cash-on-delivery order (modules/giftCards).
      giftCardCode: Joi.string().trim().max(40).optional(),
      // The signed-in shopper's store credit, with cash on delivery (modules/storeCredit).
      useStoreCredit: Joi.boolean().optional(),
      // The signed-in shopper's loyalty points to use, with cash on delivery (modules/loyalty).
      loyaltyPoints: Joi.number().integer().min(1).max(100000000).optional(),
      // A friend's invite code (modules/customerReferrals).
      referralCode: Joi.string().trim().max(16).optional(),
      // Gift wrap / gift message (modules/giftOptions).
      gift: Joi.object({ wrap: Joi.boolean(), message: Joi.string().trim().max(500).allow(''), hidePrices: Joi.boolean() }).optional(),
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
        quantity: Joi.number().integer().min(1).max(MAX_LINE_QUANTITY).default(1),
        // Answers to the product's custom fields (see cartValidation.addItem).
        customizations: customizationsInputSchema.optional(),
        // Menu options picked (catalog/menuOptions.js); priced by the server only.
        options: optionsInputSchema.optional(),
      }).optional(),
      // More "Buy Now" lines beside `item`: a quantity bundle with a variant
      // chosen per unit (one red, one blue). Priced by the server like `item`.
      extraItems: Joi.array()
        .items(
          Joi.object({
            variantId: uuid.required(),
            offerId: uuid.optional(),
            quantity: Joi.number().integer().min(1).max(MAX_LINE_QUANTITY).default(1),
            customizations: customizationsInputSchema.optional(),
            options: optionsInputSchema.optional(),
          })
        )
        .max(20)
        .optional(),
      // The shopper ticked the order bump. Only the offer is named: the server
      // accepts it only when it is the bump this checkout offers (the store's,
      // or the funnel checkout step's) and prices the line itself
      // (checkout/orderBump.js).
      orderBump: Joi.object({ offerId: uuid.required() }).optional(),
      // The product's own bumps the shopper ticked (modules/offers), at most three.
      orderBumps: Joi.array().items(Joi.object({ offerId: uuid.required() })).max(3).optional(),
      // The bot guard's fields (risk/botProtection): the honeypot, the time
      // token from GET /checkout/guard, the challenge token. Deliberately
      // loose — the guard decides, and takes them off the body.
      website: Joi.string().max(500).allow('', null).optional(),
      // The browser's own id (kept by the storefront in localStorage): device blocklist and risk.
      deviceId: Joi.string().trim().min(8).max(128).allow('', null).optional(),
      // The ad platforms' browser ids, for the server-side Purchase (marketing/pixelMatching.js). Loose: cleaned there.
      adIds: Joi.object().pattern(/^[A-Za-z]{2,12}$/, Joi.string().max(500).allow('', null)).max(10).optional(),
      botToken: Joi.string().max(500).allow('', null).optional(),
      captchaToken: Joi.string().max(4000).allow('', null).optional(),
      // Proof that the phone was verified (POST /checkout/otp/verify) — risk/checkoutOtp.
      otpToken: Joi.string().max(500).allow('', null).optional(),
      // Answers to the purchase-form fields with no column of their own
      // (sa_national_address, custom_1…5) — checkout/checkoutForm.js.
      formFields: formFieldsBodySchema,
    }),
  },
};
