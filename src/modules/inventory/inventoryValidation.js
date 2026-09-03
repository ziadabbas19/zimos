'use strict';

const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  adjust: {
    params: Joi.object({ workspaceId: uuid.required(), variantId: uuid.required() }),
    body: Joi.object({
      delta: Joi.number().integer().invalid(0).required(),
      reason: Joi.string().max(300).required(),
    }),
  },
  restock: {
    params: Joi.object({ workspaceId: uuid.required(), variantId: uuid.required() }),
    body: Joi.object({
      quantity: Joi.number().integer().min(1).required(),
      reason: Joi.string().max(300).optional(),
    }),
  },
};
