'use strict';

const Joi = require('joi');
const { REASON_CODES } = require('./returnService');

const uuid = Joi.string().uuid();

const line = Joi.object({
  orderItemId: uuid.required(),
  quantity: Joi.number().integer().min(1).required(),
});

module.exports = {
  create: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      reasonCode: Joi.string().valid(...REASON_CODES).required(),
      reasonDetail: Joi.string().max(280).allow('', null).optional(),
      items: Joi.array().items(line).min(1).required(),
    }),
  },
  listForOrder: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      status: Joi.string().valid('requested', 'approved', 'rejected', 'received', 'refunded').optional(),
    }),
  },
  moderate: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
    body: Joi.object({ action: Joi.string().valid('approve', 'reject').required() }),
  },
  restock: {
    params: Joi.object({ workspaceId: uuid.required(), returnId: uuid.required() }),
  },
};
