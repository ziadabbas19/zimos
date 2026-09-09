'use strict';

const Joi = require('joi');
const uuid = Joi.string().uuid();

const country = Joi.string().length(2).uppercase();
const rateType = Joi.string().valid('flat', 'weight_based', 'quantity_based', 'order_value_based', 'free');

// Bare field definitions shared by the create and update schemas. The create
// bodies below re-apply `.required()` / `.default(...)`; the update bodies use
// these as-is so a PATCH only writes the fields it actually sends — an
// unspecified array or flag is never reset to a default.
const zoneFields = {
  name: Joi.string().min(1).max(150),
  countries: Joi.array().items(country),
  regions: Joi.array().items(Joi.string().max(100)),
  excludedRegions: Joi.array().items(Joi.string().max(100)),
  isActive: Joi.boolean(),
};

const rateFields = {
  name: Joi.string().min(1).max(150),
  rateType,
  config: Joi.object(),
  carrierCode: Joi.string().max(100).allow(null, ''),
  isActive: Joi.boolean(),
  // Nullable so a PATCH can clear a previously set estimate.
  estimatedDeliveryMinDays: Joi.number().integer().min(0).max(3650).allow(null),
  estimatedDeliveryMaxDays: Joi.number().integer().min(0).max(3650).allow(null),
};

const createZoneBody = Joi.object({
  ...zoneFields,
  name: zoneFields.name.required(),
  countries: zoneFields.countries.default([]),
  regions: zoneFields.regions.default([]),
  excludedRegions: zoneFields.excludedRegions.default([]),
});

const updateZoneBody = Joi.object(zoneFields).min(1);

const createRateBody = Joi.object({
  ...rateFields,
  name: rateFields.name.required(),
  rateType: rateFields.rateType.required(),
  config: rateFields.config.default({}),
});

const updateRateBody = Joi.object(rateFields).min(1);

module.exports = {
  listZones: { params: Joi.object({ workspaceId: uuid.required() }) },
  zoneParams: { params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }) },
  rateParams: { params: Joi.object({ workspaceId: uuid.required(), rateId: uuid.required() }) },

  createZone: { params: Joi.object({ workspaceId: uuid.required() }), body: createZoneBody },
  updateZone: {
    params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }),
    body: updateZoneBody,
  },

  createRate: {
    params: Joi.object({ workspaceId: uuid.required(), zoneId: uuid.required() }),
    body: createRateBody,
  },
  updateRate: {
    params: Joi.object({ workspaceId: uuid.required(), rateId: uuid.required() }),
    body: updateRateBody,
  },
};
