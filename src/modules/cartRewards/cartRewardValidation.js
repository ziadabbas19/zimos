'use strict';

const Joi = require('joi');
const { TYPES, MAX_TIERS, MAX_TRUST_ITEMS, LABEL_MAX, TRUST_TEXT_MAX } = require('./cartRewardRules');
const appearance = require('./barAppearance');

const workspaceId = Joi.string().uuid().required();
// The most a threshold or a fixed reward may be: 100 million in major units of a two-decimal currency.
const MAX_AMOUNT = 10000000000;

const text = (max) => Joi.string().trim().max(max).allow('', null);

const tier = Joi.object({
  thresholdAmount: Joi.number().integer().min(1).max(MAX_AMOUNT).required(),
  type: Joi.string()
    .valid(...TYPES)
    .required(),
  // percent: 1–100; fixed: minor units; free_shipping: none (whatever is sent is dropped).
  value: Joi.any().when('type', {
    switch: [
      { is: 'percent', then: Joi.number().integer().min(1).max(100).required() },
      { is: 'fixed', then: Joi.number().integer().min(1).max(MAX_AMOUNT).required() },
    ],
    otherwise: Joi.any().strip(),
  }),
  // The merchant's own name for the reward; empty in a language = the automatic one there.
  label: Joi.object({ ar: text(LABEL_MAX), en: text(LABEL_MAX) }).allow(null).default(null),
  // The reward's icon on the bar (barAppearance.ICONS); null = by its kind.
  icon: Joi.string()
    .valid(...appearance.ICONS)
    .allow(null)
    .default(null),
});

const trustItem = Joi.object({
  text: Joi.object({ ar: text(TRUST_TEXT_MAX), en: text(TRUST_TEXT_MAX) }).required(),
  enabled: Joi.boolean().default(true),
});

const schemas = {
  get: { params: Joi.object({ workspaceId }) },
  update: {
    params: Joi.object({ workspaceId }),
    body: Joi.object({
      enabled: Joi.boolean().required(),
      allowCouponStacking: Joi.boolean().default(false),
      tiers: Joi.array().items(tier).max(MAX_TIERS).default([]),
      // The lines under the checkout button moved to the store's cart behavior
      // (storefront/cartSheet.js). Left out (today's dashboard), the ones kept
      // here are left as they are; still taken from an older dashboard.
      trustItems: Joi.array().items(trustItem).max(MAX_TRUST_ITEMS).optional(),
      // The bar's look (barAppearance.js). Left out (a dashboard from before
      // it), the look already saved is kept.
      appearance: appearance.schema.optional(),
    }),
  },
  publicConfig: { params: Joi.object({ workspaceId }) },
};

module.exports = { schemas, MAX_AMOUNT };
