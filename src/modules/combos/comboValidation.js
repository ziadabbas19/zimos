'use strict';

const Joi = require('joi');
const { cleanText } = require('../platformSettings/rules');

const uuid = Joi.string().uuid();

/** The variants a shopper picked in a combo: one per component that lets them choose. */
const comboSelectionSchema = Joi.array()
  .items(Joi.object({ itemId: uuid.required(), variantId: uuid.required() }))
  .max(10);

/** Words the store shows: no tags, no control or hidden characters. */
const plain = (max, multiline = false) =>
  Joi.string()
    .max(max * 4)
    .custom((value, helpers) => {
      const cleaned = cleanText(value, { multiline });
      if (cleaned.length > max) return helpers.message(`${helpers.state.path.join('.')} must be at most ${max} characters`);
      return cleaned;
    });

// A component: a product, and either its variant or pickVariant (the shopper chooses).
const item = Joi.object({
  productId: uuid.required(),
  variantId: uuid.allow(null),
  pickVariant: Joi.boolean().default(false),
  quantity: Joi.number().integer().min(1).max(100).default(1),
});

const fields = {
  name: plain(200).min(1),
  description: plain(2000, true).allow('', null),
  imageUrl: Joi.string().uri({ scheme: ['http', 'https'] }).max(1000).allow('', null),
  status: Joi.string().valid('draft', 'active', 'archived'),
  pricingMode: Joi.string().valid('fixed_price', 'percent_off', 'amount_off'),
  // fixed_price / amount_off: minor units; percent_off: basis points (1000 = 10%).
  priceValue: Joi.number().integer().min(0).max(100000000000),
  showOnProductIds: Joi.array().items(uuid).max(50).unique(),
  items: Joi.array().items(item).min(2).max(10),
};

const ws = { workspaceId: uuid.required() };

module.exports = {
  comboSelectionSchema,
  list: { params: Joi.object(ws), query: Joi.object({ status: Joi.string().valid('draft', 'active', 'archived') }) },
  one: { params: Joi.object({ ...ws, comboId: uuid.required() }) },
  create: {
    params: Joi.object(ws),
    body: Joi.object({
      ...fields,
      name: fields.name.required(),
      pricingMode: fields.pricingMode.default('fixed_price'),
      priceValue: fields.priceValue.required(),
      status: fields.status.default('draft'),
      items: fields.items.required(),
    }),
  },
  update: { params: Joi.object({ ...ws, comboId: uuid.required() }), body: Joi.object(fields).min(1) },
  preview: {
    params: Joi.object(ws),
    body: Joi.object({ pricingMode: fields.pricingMode.required(), priceValue: fields.priceValue.required(), items: fields.items.required() }),
  },
  publicList: { params: Joi.object({ workspaceId: Joi.string().required() }), query: Joi.object({ productId: uuid.optional() }) },
};
