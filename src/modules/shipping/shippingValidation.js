'use strict';

const Joi = require('joi');
const uuid = Joi.string().uuid();

const country = Joi.string().length(2).uppercase();
const rateType = Joi.string().valid('flat', 'weight_based', 'quantity_based', 'order_value_based', 'free');

const zoneBody = Joi.object({
  name: Joi.string().min(1).max(150).required(),
  countries: Joi.array().items(country).default([]),
  regions: Joi.array().items(Joi.string().max(100)).default([]),
  excludedRegions: Joi.array().items(Joi.string().max(100)).default([]),
});

const rateBody = Joi.object({
  name: Joi.string().min(1).max(150).required(),
  rateType: rateType.required(),
  config: Joi.object().default({}),
  carrierCode: Joi.string().max(100).allow(null, '').optional(),
});

module.exports = {
  listZones: { params: Joi.object({ workspaceId: uuid.required() }) },
  zoneParams: { params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }) },
  rateParams: { params: Joi.object({ workspaceId: uuid.required(), rateId: uuid.required() }) },

  createZone: { params: Joi.object({ workspaceId: uuid.required() }), body: zoneBody },
  updateZone: {
    params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }),
    body: zoneBody.fork(['name'], (s) => s.optional()).min(1),
  },

  createRate: {
    params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }),
    body: rateBody,
  },
  updateRate: {
    params: Joi.object({ workspaceId: uuid.required(), rateId: uuid.required() }),
    body: rateBody.fork(['name', 'rateType'], (s) => s.optional()).min(1),
  },
};
