'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { ALL_PERMISSIONS } = require('../../core/security/permissions');
const { workspaceSlug, SLUG_LOOKUP_MAX } = require('../../core/utils/workspaceSlug');
const { CHECKOUT_FIELD_MODES, CHECKOUT_NOTES_MODES } = require('../checkout/checkoutSettings');
const { FRAUD_ACTIONS } = require('../fraud/fraudRules');

const uuid = Joi.string().uuid();

module.exports = {
  create: { body: Joi.object({ name: Joi.string().min(2).max(200).required() }) },
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
        // Which optional checkout fields this store asks for. Key names track
        // the checkout request fields they govern — see
        // modules/checkout/checkoutSettings.js. Sub-keys merge, so a form that
        // toggles one switch cannot blank the others; `null` on a sub-key (or
        // on the whole object) restores the default.
        checkout_settings: Joi.object({
          email: Joi.string().valid(...CHECKOUT_FIELD_MODES).allow(null).optional(),
          postal_code: Joi.string().valid(...CHECKOUT_FIELD_MODES).allow(null).optional(),
          notes: Joi.string().valid(...CHECKOUT_NOTES_MODES).allow(null).optional(),
        })
          .allow(null)
          .optional(),
        // Storefront fraud rules — see modules/fraud/fraudRules.js. Same
        // merge semantics as checkout_settings: sub-keys merge, `null` on a
        // sub-key restores its default (a numeric rule's default is "off"),
        // `null` on the whole object turns every rule off.
        fraud_rules: Joi.object({
          action: Joi.string().valid(...FRAUD_ACTIONS).allow(null).optional(),
          block_blacklisted: Joi.boolean().allow(null).optional(),
          duplicate_window_minutes: Joi.number().integer().min(1).max(10080).allow(null).optional(),
          max_orders_per_phone_per_day: Joi.number().integer().min(1).max(100).allow(null).optional(),
          high_rejection_threshold: Joi.number().integer().min(1).max(100).allow(null).optional(),
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
