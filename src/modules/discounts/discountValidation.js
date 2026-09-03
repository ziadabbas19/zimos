'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  create: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      code: Joi.string().max(100).uppercase().optional(),
      type: Joi.string().valid('percentage', 'fixed', 'free_shipping', 'buy_x_get_y').required(),
      value: Joi.number().integer().min(0).optional(),
      buyXGetYConfig: Joi.object().optional(),
      minimumSubtotal: Joi.number().integer().min(0).optional(),
      productRestrictions: Joi.array().items(uuid).default([]),
      collectionRestrictions: Joi.array().items(uuid).default([]),
      customerRestrictions: Joi.array().items(uuid).default([]),
      funnelRestrictions: Joi.array().items(uuid).default([]),
      startsAt: Joi.date().iso().optional(),
      endsAt: Joi.date().iso().optional(),
      usageLimit: Joi.number().integer().min(1).optional(),
      perCustomerLimit: Joi.number().integer().min(1).optional(),
      stackable: Joi.boolean().default(false),
    }),
  },
  list: { params: Joi.object({ workspaceId: uuid.required() }) },
  get: { params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }) },
  remove: { params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }) },
  setStatus: {
    params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }),
    body: Joi.object({ status: Joi.string().valid('active', 'disabled', 'archived').required() }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), discountId: uuid.required() }),
    body: Joi.object({
      code: Joi.string().max(100).uppercase().allow(null).optional(),
      type: Joi.string().valid('percentage', 'fixed', 'free_shipping', 'buy_x_get_y').optional(),
      value: Joi.number().integer().min(0).allow(null).optional(),
      buyXGetYConfig: Joi.object().allow(null).optional(),
      minimumSubtotal: Joi.number().integer().min(0).allow(null).optional(),
      productRestrictions: Joi.array().items(uuid).optional(),
      collectionRestrictions: Joi.array().items(uuid).optional(),
      customerRestrictions: Joi.array().items(uuid).optional(),
      funnelRestrictions: Joi.array().items(uuid).optional(),
      startsAt: Joi.date().iso().allow(null).optional(),
      endsAt: Joi.date().iso().allow(null).optional(),
      usageLimit: Joi.number().integer().min(1).allow(null).optional(),
      perCustomerLimit: Joi.number().integer().min(1).allow(null).optional(),
      stackable: Joi.boolean().optional(),
      status: Joi.string().valid('active', 'disabled', 'archived').optional(),
    }).min(1),
  },
};
