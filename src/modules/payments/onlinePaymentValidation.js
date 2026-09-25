'use strict';

const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const wsParam = Joi.object({ workspaceId: uuid.required() });
const gatewayParam = Joi.object({ workspaceId: uuid.required(), code: Joi.string().max(50).required() });
const storeOrderParam = Joi.object({ workspaceId: workspaceRef().required(), orderId: uuid.required() });

module.exports = {
  workspace: { params: wsParam },
  connect: {
    params: gatewayParam,
    // The adapter validates the inside of `credentials` and `settings`.
    body: Joi.object({
      credentials: Joi.object().unknown(true).optional(),
      settings: Joi.object().unknown(true).optional(),
    }),
  },
  gateway: { params: gatewayParam },
  updateMethods: {
    params: wsParam,
    body: Joi.object({
      methods: Joi.array()
        .items(Joi.object({ id: Joi.string().max(100).required(), enabled: Joi.boolean().required() }))
        .min(1)
        .max(50)
        .required(),
    }),
  },
  storeMethods: { params: Joi.object({ workspaceId: workspaceRef().required() }) },
  shopperStatus: {
    params: storeOrderParam,
    query: Joi.object({ refresh: Joi.string().valid('0', '1', 'true', 'false').optional() }),
  },
  shopperReturn: {
    params: storeOrderParam,
    // The gateway's redirect query string, as the shopper's browser received it.
    body: Joi.object({
      query: Joi.object()
        .pattern(Joi.string().max(100), Joi.alternatives().try(Joi.string().max(2000).allow(''), Joi.number(), Joi.boolean()))
        .max(100)
        .optional(),
    }),
  },
  shopperRetry: {
    params: storeOrderParam,
    body: Joi.object({
      paymentMethod: Joi.string().valid('card', 'wallet').optional(),
      paymentProvider: Joi.string().max(50).optional(),
      returnUrl: Joi.string().max(2000).optional(),
    }),
  },
  shopperAction: { params: storeOrderParam },
  webhook: {
    params: Joi.object({ code: Joi.string().max(50).required(), token: Joi.string().max(100).required() }),
  },
};
