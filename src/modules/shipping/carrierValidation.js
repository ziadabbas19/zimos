'use strict';

const Joi = require('joi');

const uuid = Joi.string().uuid();
const code = Joi.string().pattern(/^[a-z0-9_-]{1,50}$/);

module.exports = {
  list: { params: Joi.object({ workspaceId: uuid.required() }) },
  connect: {
    params: Joi.object({ workspaceId: uuid.required(), code: code.required() }),
    // Both objects are carrier-specific; the adapter's own schemas validate
    // them (carrierAccountService.connect). `credentials` may be omitted to
    // change only the settings of an existing connection.
    body: Joi.object({
      credentials: Joi.object().unknown(true).optional(),
      settings: Joi.object().unknown(true).optional(),
    }).min(1),
  },
  byCode: { params: Joi.object({ workspaceId: uuid.required(), code: code.required() }) },
  cities: {
    params: Joi.object({ workspaceId: uuid.required(), code: code.required() }),
    query: Joi.object({ cityId: Joi.string().max(100).optional() }),
  },
  shipmentAction: {
    params: Joi.object({ workspaceId: uuid.required(), orderId: uuid.required(), shipmentId: uuid.required() }),
  },
  webhook: {
    params: Joi.object({ code: code.required(), token: Joi.string().max(200).required() }),
  },
};
