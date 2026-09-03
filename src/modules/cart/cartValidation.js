'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  workspaceParam: { params: Joi.object({ workspaceId: uuid.required() }) },
  addItem: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      variantId: uuid.required(),
      offerId: uuid.optional(),
      quantity: Joi.number().integer().min(1).default(1),
    }),
  },
  updateItem: {
    params: Joi.object({ workspaceId: uuid.required(), itemId: uuid.required() }),
    body: Joi.object({ quantity: Joi.number().integer().min(0).required() }),
  },
  removeItem: {
    params: Joi.object({ workspaceId: uuid.required(), itemId: uuid.required() }),
  },
};
