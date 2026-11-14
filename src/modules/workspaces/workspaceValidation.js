'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { ALL_PERMISSIONS } = require('../../core/security/permissions');
const { workspaceSlug, SLUG_LOOKUP_MAX } = require('../../core/utils/workspaceSlug');
const { CHECKOUT_FIELD_MODES, CHECKOUT_NOTES_MODES } = require('../checkout/checkoutSettings');
const { checkoutFormSettingsKeys } = require('../checkout/checkoutForm');
const { thankYouPageSchema } = require('../storefront/thankYouPage');
const { storeInfoSchema, legalSchema } = require('../storefront/storeInfo');
const {
  generalSchema,
  socialLinksSchema,
  floatingWhatsappSchema,
  storeSeoSchema,
} = require('../storefront/generalSettings');
const { FRAUD_ACTIONS, PHONE_VALIDATION_MODES } = require('../fraud/fraudRules');
const { settingsSchema: checkoutOtpSettingsSchema } = require('../risk/checkoutOtp');

// A fraud rule is stored as its bare value (the older shape) or as { value, action }.
const fraudAction = Joi.string().valid(...FRAUD_ACTIONS);
const fraudRule = (value) =>
  Joi.alternatives()
    .try(value, Joi.object({ value: value.allow(null).required(), action: fraudAction.allow(null).optional() }))
    .allow(null)
    .optional();
const { catalogSettingsSchema } = require('../storefront/catalogSettings');
const { orderBumpSettingsSchema } = require('../checkout/orderBump');

const uuid = Joi.string().uuid();

module.exports = {
  create: {
    body: Joi.object({
      name: Joi.string().min(2).max(200).required(),
      // An agent's referral code, attached to the workspace's subscription.
      // Optional; an unusable one refuses the whole creation (422).
      referralCode: Joi.string().trim().max(64).allow('', null).optional(),
      // The plan for this store, one offered publicly (GET /plans/public).
      // Read only while REQUIRE_PLAN_AT_SIGNUP is on; otherwise the store gets
      // the default plan, as before. Without one, the first store takes the
      // plan chosen at sign-up.
      planId: uuid.allow(null).optional(),
      billingCycle: Joi.string().valid('monthly', 'yearly').allow(null).optional(),
    }),
  },
  // Only the length is policed here: every other rule comes back as a `reason`
  // in a 200 response instead of a validation error, so the merchant UI can
  // explain what is wrong with an address as it is typed.
  checkSlug: {
    query: Joi.object({ slug: Joi.string().trim().min(1).max(SLUG_LOOKUP_MAX).required() }),
  },
  updateWorkspace: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().min(2).max(200).optional(),
      // The store's public address (<slug>.PLATFORM_ROOT_DOMAIN). A reserved
      // or malformed value is refused here as 422; one another workspace
      // already holds comes back from the service as 409.
      slug: workspaceSlug().optional(),
      logoUrl: Joi.string().uri().allow('', null).max(1000).optional(),
      tagline: Joi.string().allow('', null).max(300).optional(),
      // Opaque theme blob; light key cap here, ~5KB size cap in the service.
      themeSettings: Joi.object().unknown(true).max(50).optional(),
      // Merchant-tunable store settings merged into workspaces.settings JSONB.
      // Amounts are integer minor currency units (piastres/cents), the same
      // convention as every amount column. `null` clears a value back to
      // "not configured"; unknown keys are stripped by the validate middleware.
      settings: Joi.object({
        free_shipping_threshold_amount: Joi.number().integer().min(0).allow(null).optional(),
        default_shipping_rate_amount: Joi.number().integer().min(0).allow(null).optional(),
        tax_enabled: Joi.boolean().optional(),
        // Grams used for a product with no weight when pricing by weight tiers
        // or telling a courier the parcel weight. Tier mode needs it set.
        default_item_weight_grams: Joi.number().integer().min(1).max(1000000).allow(null).optional(),
        // The message the confirmation queue's WhatsApp button opens with.
        // Placeholders {store} {orderNumber} {items} {total} {customerName} are
        // filled in by the dashboard; `null` goes back to its built-in text.
        confirmation_whatsapp_template: Joi.string().trim().min(1).max(1000).allow(null).optional(),
        // The storefront listing: sidebar on/off, which filters in what order,
        // and the default sort (storefront/catalogSettings.js). Sent whole and
        // stored whole; `null` goes back to the defaults.
        storefront_catalog: catalogSettingsSchema.allow(null).optional(),
        // The store checkout's order bump: which offer, and the card's title
        // and text (checkout/orderBump.js). Sent whole and stored whole;
        // `null` removes it.
        order_bump: orderBumpSettingsSchema.allow(null).optional(),
        // Funnel upsells joined to the checkout order within an offer window
        // (funnels/funnelOfferMerge.js). Off unless true; needs orders.manage.
        funnel_upsell_merge: Joi.boolean().allow(null).optional(),
        // How long a funnel order waits for its offers at most; null → 15.
        funnel_offer_window_minutes: Joi.number().integer().min(1).max(120).allow(null).optional(),
        // Browser ad pixels loaded on the public store. IDs only (no secrets);
        // the server-side tokens live in /server-pixels.
        tracking_pixels: Joi.object({
          meta: Joi.string().pattern(/^\d{5,20}$/).allow(null, '').optional(),
          tiktok: Joi.string().pattern(/^[A-Z0-9]{10,30}$/).allow(null, '').optional(),
          snapchat: Joi.string().pattern(/^[a-f0-9-]{20,40}$/i).allow(null, '').optional(),
          google_tag: Joi.string().pattern(/^(G|AW|GT)-[A-Z0-9]{4,20}$/).allow(null, '').optional(),
        })
          .allow(null)
          .optional(),
        // Which optional checkout fields this store asks for. Key names track
        // the checkout request fields they govern — see
        // modules/checkout/checkoutSettings.js. Sub-keys merge, so a form that
        // toggles one switch cannot blank the others; `null` on a sub-key (or
        // on the whole object) restores the default.
        checkout_settings: Joi.object({
          email: Joi.string().valid(...CHECKOUT_FIELD_MODES).allow(null).optional(),
          postal_code: Joi.string().valid(...CHECKOUT_FIELD_MODES).allow(null).optional(),
          notes: Joi.string().valid(...CHECKOUT_NOTES_MODES).allow(null).optional(),
          // The purchase form builder: the ordered field list and the form's
          // options (checkout/checkoutForm.js).
          ...checkoutFormSettingsKeys,
        })
          .allow(null)
          .optional(),
        // The store's thank-you page (storefront/thankYouPage.js). Sent whole
        // and stored whole; `null` goes back to the built-in page.
        thank_you_page: thankYouPageSchema.allow(null).optional(),
        // Store contact details and short policies, and the long legal
        // policies (storefront/storeInfo.js). Each sent whole and stored whole.
        store_info: storeInfoSchema.allow(null).optional(),
        legal: legalSchema.allow(null).optional(),
        // Favicon and country, social links, the floating WhatsApp button and
        // store-level SEO (storefront/generalSettings.js). Each sent whole.
        general: generalSchema.allow(null).optional(),
        social_links: socialLinksSchema.allow(null).optional(),
        floating_whatsapp: floatingWhatsappSchema.allow(null).optional(),
        store_seo: storeSeoSchema.allow(null).optional(),
        // How the store's cart opens and moves (storefront/cartSheet.js): the
        // taps that open it, bottom sheet / side drawer / popup, the speed.
        // Sent whole and stored whole; `null` goes back to the defaults.
        cart_sheet: require('../storefront/cartSheet').schema.allow(null).optional(),
        // The extra languages the store offers (modules/translations). Sent whole.
        store_languages: require('../translations/translations').storeLanguagesSchema.allow(null).optional(),
        // Storefront fraud rules — see modules/fraud/fraudRules.js. Same
        // merge semantics as checkout_settings: sub-keys merge, `null` on a
        // sub-key restores its default (a numeric rule's default is "off"),
        // `null` on the whole object turns every rule off.
        fraud_rules: Joi.object({
          action: Joi.string().valid(...FRAUD_ACTIONS).allow(null).optional(),
          block_blacklisted: Joi.boolean().allow(null).optional(),
          duplicate_window_minutes: fraudRule(Joi.number().integer().min(1).max(10080)),
          max_orders_per_phone_per_day: fraudRule(Joi.number().integer().min(1).max(100)),
          high_rejection_threshold: fraudRule(Joi.number().integer().min(1).max(100)),
          max_items_per_order: fraudRule(Joi.number().integer().min(0).max(1000)),
          min_minutes_between_cod_orders_per_ip: fraudRule(Joi.number().integer().min(1).max(10080)),
          block_outside_country: fraudRule(Joi.boolean()),
          allowed_countries: Joi.array().items(Joi.string().length(2).uppercase()).max(60).unique().allow(null).optional(),
          block_vpn: fraudRule(Joi.boolean()),
          // Checkout bot guard (risk/botProtection): on/off, and the invisible challenge.
          bot_protection: Joi.boolean().allow(null).optional(),
          bot_captcha: Joi.boolean().allow(null).optional(),
          // Lost orders: minutes of silence after which a checkout counts as abandoned (default 15).
          abandoned_after_minutes: Joi.number().integer().min(5).max(1440).allow(null).optional(),
          // Phone verification at checkout (risk/checkoutOtp). Sent whole.
          checkout_otp: checkoutOtpSettingsSchema.allow(null).optional(),
          // Visitors from these countries do not see the store at all (risk/visitorGate).
          blocked_countries: Joi.array().items(Joi.string().length(2).uppercase()).max(250).unique().allow(null).optional(),
          min_network_delivery_rate: fraudRule(Joi.number().integer().min(1).max(100)),
          high_risk: fraudRule(Joi.boolean()),
          phone_validation: Joi.string().valid(...PHONE_VALIDATION_MODES).allow(null).optional(),
        })
          .allow(null)
          .optional(),
      }).optional(),
    }).min(1),
  },
  invite: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ email: joiEmail().required(), roleId: uuid.required() }),
  },
  listMembers: { params: Joi.object({ workspaceId: uuid.required() }) },
  // The plan to try: the store's own (omitted) or another one on offer.
  startTrial: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ planId: uuid.optional() }),
  },
  resendInvite: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
  },
  updateRole: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
    body: Joi.object({ roleId: uuid.required() }),
  },
  removeMember: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
  },
  createRole: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().min(2).max(100).required(),
      key: Joi.string().min(2).max(64).pattern(/^[a-z0-9_]+$/).required(),
      permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)).min(1).required(),
    }),
  },
};
