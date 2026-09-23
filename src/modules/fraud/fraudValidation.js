'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  listFlagged: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(30),
      // The last order id of the previous page (its nextCursor), not a timestamp.
      before: uuid.optional(),
      includeResolved: Joi.boolean().default(false),
    }),
  },
  approve: { params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }) },
  listBlocklist: { params: Joi.object({ workspaceId: uuid.required() }) },
  block: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      phone: Joi.string().trim().min(1).max(32).required(),
      reason: Joi.string().trim().min(2).max(300).required(),
      fullName: Joi.string().trim().max(200).allow(null, '').optional(),
    }),
  },
};
