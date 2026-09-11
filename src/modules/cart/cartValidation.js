'use strict';
const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');

const uuid = Joi.string().uuid();
const workspaceIdParam = workspaceRef().required();

module.exports = {
  workspaceParam: { params: Joi.object({ workspaceId: workspaceIdParam }) },
  addItem: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    body: Joi.object({
      variantId: uuid.required(),
      offerId: uuid.optional(),
      quantity: Joi.number().integer().min(1).default(1),
    }),
  },
  updateItem: {
    params: Joi.object({ workspaceId: workspaceIdParam, itemId: uuid.required() }),
    body: Joi.object({ quantity: Joi.number().integer().min(0).required() }),
  },
  removeItem: {
    params: Joi.object({ workspaceId: workspaceIdParam, itemId: uuid.required() }),
  },
};
