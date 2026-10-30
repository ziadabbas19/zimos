'use strict';
const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const { CATALOG_SORTS } = require('./catalogSettings');

const uuid = Joi.string().uuid();
const workspaceIdParam = workspaceRef().required();

module.exports = {
  listProducts: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    query: Joi.object({
      collectionId: uuid.optional(),
      // A collection by id or slug; its sub-collections' products are included.
      collection: Joi.string().trim().min(1).max(200).optional(),
      // One tag, or several (?tag=a&tag=b): a product with any of them.
      tag: Joi.alternatives()
        .try(Joi.string().trim().max(100), Joi.array().items(Joi.string().trim().max(100)).max(20))
        .optional(),
      search: Joi.string().trim().max(200).allow('').optional(),
      // Minor units, compared with each active variant's price.
      minPrice: Joi.number().integer().min(0).optional(),
      maxPrice: Joi.number().integer().min(0).optional(),
      // Built from ?option[Size]=M&option[Size]=L by optionFilters.js.
      options: Joi.object()
        .pattern(Joi.string().max(100), Joi.array().items(Joi.string().max(100)).min(1).max(20))
        .max(10)
        .optional(),
      sort: Joi.string()
        .valid('relevance', ...CATALOG_SORTS)
        .optional(),
      page: Joi.number().integer().min(1).max(1000).optional(),
      // Counts per collection, tag, option value and the price range.
      facets: Joi.boolean().optional(),
      limit: Joi.number().integer().min(1).max(100).default(24),
      cursor: uuid.optional(),
    }),
  },
  suggest: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    query: Joi.object({ q: Joi.string().trim().max(100).allow('').required() }),
  },
  getProduct: {
    params: Joi.object({ workspaceId: workspaceIdParam, idOrSlug: Joi.string().max(300).required() }),
  },
  // Public order tracking. Both values are required and neither has a default:
  // a lookup that names only a phone must not return "their latest order".
  // `number` is capped at the width of orders.order_number (40).
  // The signed tracking link: an unguessable token instead of phone + number.
  trackLink: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    query: Joi.object({ token: Joi.string().required().regex(/^[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{32}$/) }),
  },
  track: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    query: Joi.object({
      phone: Joi.string().required().regex(/^[0-9]{10,15}$/),
      number: Joi.string().required().trim().regex(/^[A-Za-z0-9-]{3,40}$/),
    }),
  },
  // Shipping price for the checkout form. `items` or an X-Cart-Token header,
  // like checkout itself. `governorate` is the address's province.
  shippingQuote: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    body: Joi.object({
      country: Joi.string().length(2).uppercase().default('EG'),
      governorate: Joi.string().max(100).allow(null, '').optional(),
      items: Joi.array()
        .items(
          Joi.object({
            // Not needed for a combo: its products name their own variants.
            variantId: uuid.when('comboId', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
            offerId: uuid.optional(),
            quantity: Joi.number().integer().min(1).max(1000).default(1),
            // A whole combo (modules/combos) and the variants picked in it, as the cart line holds it.
            comboId: uuid.optional(),
            comboSelection: require('../combos/comboValidation').comboSelectionSchema.optional(),
            // The product form's custom-field answers: a priced field changes the subtotal.
            customizations: require('../catalog/customFields').customizationsInputSchema.optional(),
            // Menu options picked: their prices count in the quoted subtotal.
            options: require('../catalog/menuOptions').optionsInputSchema.optional(),
          })
        )
        .min(1)
        .max(50)
        .optional(),
      // Quoted for a funnel's checkout: the funnel's shipping group applies.
      funnelId: uuid.optional(),
    }),
  },
  workspaceParam: { params: Joi.object({ workspaceId: workspaceIdParam }) },
  getPolicy: { params: Joi.object({ workspaceId: workspaceIdParam, key: Joi.string().trim().max(40).required() }) },
  // An id or a slug.
  getCollection: { params: Joi.object({ workspaceId: workspaceIdParam, collectionId: Joi.string().trim().min(1).max(200).required() }) },
};
