'use strict';

const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  submit: {
    params: Joi.object({ workspaceId: uuid.required(), productId: uuid.required() }),
    body: Joi.object({
      phone: Joi.string().min(6).max(32).required(),
      rating: Joi.number().integer().min(1).max(5).required(),
      comment: Joi.string().max(2000).allow('', null).optional(),
    }),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ status: Joi.string().valid('pending', 'approved', 'rejected').optional() }),
  },
  moderate: {
    params: Joi.object({ workspaceId: uuid.required(), reviewId: uuid.required() }),
    body: Joi.object({ action: Joi.string().valid('approve', 'reject').required() }),
  },
};
