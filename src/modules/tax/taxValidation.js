'use strict';

const Joi = require('joi');
const uuid = Joi.string().uuid();

const body = Joi.object({
  name: Joi.string().min(1).max(150).required(),
  country: Joi.string().length(2).uppercase().allow(null).optional(),
  region: Joi.string().max(100).allow(null, '').optional(),
  rateBasisPoints: Joi.number().integer().min(0).max(100000).required(),
  appliesToShipping: Joi.boolean().default(false),
  pricesIncludeTax: Joi.boolean().default(false),
  productId: uuid.allow(null).optional(),
});

module.exports = {
  list: { params: Joi.object({ workspaceId: uuid.required() }) },
  params: { params: Joi.object({ workspaceId: uuid.required(), taxRateId: uuid.required() }) },
  create: { params: Joi.object({ workspaceId: uuid.required() }), body },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), taxRateId: uuid.required() }),
    body: body.fork(['name', 'rateBasisPoints'], (s) => s.optional()).min(1),
  },
};
