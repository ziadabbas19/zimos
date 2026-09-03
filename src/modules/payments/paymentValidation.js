'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  initialize: { params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }) },
  capture: { params: Joi.object({ workspaceId: uuid.required(), paymentId: uuid.required() }) },
  refund: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({ amount: Joi.number().integer().min(1).required(), reason: Joi.string().max(300).optional() }),
  },
};
