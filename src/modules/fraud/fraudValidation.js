'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();
const entryType = Joi.string().valid('phone', 'ip', 'email', 'device', 'name_address');
const entryScope = Joi.string().valid('orders', 'otp', 'visit');

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
  listBlocklist: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      type: entryType.optional(),
      scope: entryScope.optional(),
      q: Joi.string().trim().min(1).max(100).optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      // The last entry id of the previous page (its nextCursor).
      cursor: uuid.optional(),
    }),
  },
  block: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      type: entryType.default('phone'),
      // The identifier itself; "phone" is the older name for a phone value.
      value: Joi.string().trim().min(1).max(255).optional(),
      phone: Joi.string().trim().min(1).max(32).optional(),
      // type = name_address only.
      name: Joi.string().trim().min(1).max(200).optional(),
      address: Joi.string().trim().min(1).max(500).optional(),
      scope: entryScope.optional(),
      scopes: Joi.array().items(entryScope).min(1).max(3).unique().optional(),
      reason: Joi.string().trim().min(2).max(300).allow(null, '').optional(),
      fullName: Joi.string().trim().max(200).allow(null, '').optional(),
    }),
  },
  blockAndCancel: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required() }),
    body: Joi.object({
      reason: Joi.string().trim().min(2).max(300).allow(null, '').optional(),
      // The order is booked with a courier that has no cancel API, and the merchant cancelled it there.
      acknowledgeManualCancel: Joi.boolean().optional(),
    }).default({}),
  },
  stats: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ from: Joi.date().iso().optional(), to: Joi.date().iso().optional() }),
  },
  capabilities: { params: Joi.object({ workspaceId: uuid.required() }) },
  networkScores: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ customerIds: Joi.array().items(uuid).min(1).max(200).unique().required() }),
  },
  unblock: { params: Joi.object({ workspaceId: uuid.required(), entryId: uuid.required() }) },
  importBlocklist: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      csv: Joi.string().min(1).max(1500000).required(),
      type: entryType.default('phone'),
      scope: entryScope.default('orders'),
      reason: Joi.string().trim().max(300).allow(null, '').optional(),
    }),
  },
};
