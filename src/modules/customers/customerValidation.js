'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  list: { params: Joi.object({ workspaceId: uuid.required() }), query: Joi.object({ limit: Joi.number().integer().min(1).max(200).default(50), cursor: uuid.optional(), blacklistedOnly: Joi.boolean().optional() }) },
  get: { params: Joi.object({ workspaceId: uuid.required(), customerId: uuid.required() }) },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), customerId: uuid.required() }),
    body: Joi.object({
      fullName: Joi.string().max(200).allow(null, '').optional(),
      email: Joi.string().email().max(255).allow(null, '').optional(),
      phone: Joi.string().max(32).optional(),
      alternatePhone: Joi.string().max(32).allow(null, '').optional(),
      marketingConsent: Joi.boolean().optional(),
    }).min(1),
  },
  blacklist: {
    params: Joi.object({ workspaceId: uuid.required(), customerId: uuid.required() }),
    body: Joi.object({ isBlacklisted: Joi.boolean().required(), reason: Joi.string().max(300).when('isBlacklisted', { is: true, then: Joi.required() }) }),
  },
  addAddress: {
    params: Joi.object({ workspaceId: uuid.required(), customerId: uuid.required() }),
    body: Joi.object({
      country: Joi.string().length(2).required(),
      province: Joi.string().max(100).optional(),
      city: Joi.string().max(100).required(),
      addressLine: Joi.string().max(500).required(),
      postalCode: Joi.string().max(20).optional(),
      notes: Joi.string().max(500).optional(),
      isDefault: Joi.boolean().default(false),
    }),
  },
  updateAddress: {
    params: Joi.object({ workspaceId: uuid.required(), customerId: uuid.required(), addressId: uuid.required() }),
    body: Joi.object({
      country: Joi.string().length(2).optional(),
      province: Joi.string().max(100).allow(null, '').optional(),
      city: Joi.string().max(100).optional(),
      addressLine: Joi.string().max(500).optional(),
      postalCode: Joi.string().max(20).allow(null, '').optional(),
      notes: Joi.string().max(500).allow(null, '').optional(),
      isDefault: Joi.boolean().optional(),
    }).min(1),
  },
};
