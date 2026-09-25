'use strict';
const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const workspaceIdParam = workspaceRef().required();

module.exports = {
  listProducts: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    query: Joi.object({
      collectionId: uuid.optional(),
      tag: Joi.string().max(100).optional(),
      search: Joi.string().max(200).optional(),
      limit: Joi.number().integer().min(1).max(100).default(24),
      cursor: uuid.optional(),
    }),
  },
  getProduct: {
    params: Joi.object({ workspaceId: workspaceIdParam, idOrSlug: Joi.string().max(300).required() }),
  },
  // Public order tracking. Both values are required and neither has a default:
  // a lookup that names only a phone must not return "their latest order".
  // `number` is capped at the width of orders.order_number (40).
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
            variantId: uuid.required(),
            offerId: uuid.optional(),
            quantity: Joi.number().integer().min(1).max(1000).default(1),
          })
        )
        .min(1)
        .max(50)
        .optional(),
    }),
  },
  workspaceParam: { params: Joi.object({ workspaceId: workspaceIdParam }) },
  getCollection: { params: Joi.object({ workspaceId: workspaceIdParam, collectionId: uuid.required() }) },
};
