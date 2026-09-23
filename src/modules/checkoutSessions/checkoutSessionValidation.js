'use strict';
const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const RECOVERY_STATUSES = ['not_contacted', 'contacted', 'recovered', 'lost'];

module.exports = {
  // Public storefront autosave. Prices are never accepted: every line is
  // priced from the catalogue server-side.
  capture: {
    params: Joi.object({ workspaceId: workspaceRef().required() }),
    body: Joi.object({
      contact: Joi.object({
        fullName: Joi.string().max(200).allow(null, '').optional(),
        phone: Joi.string().max(32).required(),
        email: joiEmail().allow(null, '').optional(),
      }).required(),
      items: Joi.array()
        .items(
          Joi.object({
            variantId: uuid.required(),
            offerId: uuid.optional(),
            quantity: Joi.number().integer().min(1).max(100).required(),
          })
        )
        .min(1)
        .max(20)
        .required(),
      source: Joi.string().valid('store', 'funnel').default('store'),
      visitorId: Joi.string().min(8).max(64).required(),
    }),
  },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      view: Joi.string().valid('abandoned', 'converted', 'all').default('abandoned'),
      recoveryStatus: Joi.string().valid(...RECOVERY_STATUSES).optional(),
      limit: Joi.number().integer().min(1).max(100).default(30),
      before: uuid.optional(),
    }),
  },
  update: {
    params: Joi.object({ workspaceId: uuid.required(), sessionId: uuid.required() }),
    body: Joi.object({ recoveryStatus: Joi.string().valid(...RECOVERY_STATUSES).required() }),
  },
};
