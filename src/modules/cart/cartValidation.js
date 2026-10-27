'use strict';
const Joi = require('joi');
const { workspaceRef } = require('../../core/utils/workspaceSlug');
const { customizationsInputSchema } = require('../catalog/customFields');
const { MAX_LINE_QUANTITY } = require('../checkout/checkoutValidation');

const uuid = Joi.string().uuid();
const workspaceIdParam = workspaceRef().required();

module.exports = {
  workspaceParam: { params: Joi.object({ workspaceId: workspaceIdParam }) },
  addItem: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    body: Joi.object({
      variantId: uuid.required(),
      offerId: uuid.optional(),
      quantity: Joi.number().integer().min(1).max(MAX_LINE_QUANTITY).default(1),
      // Answers to the product's custom fields: field id → text, or the id of
      // a photo uploaded to POST /uploads. Checked against the product.
      customizations: customizationsInputSchema.optional(),
      // Menu options picked: [{ groupId, choiceIds }] (catalog/menuOptions.js); prices come from the server.
      options: require('../catalog/menuOptions').optionsInputSchema.optional(),
    }),
  },
  updateItem: {
    params: Joi.object({ workspaceId: workspaceIdParam, itemId: uuid.required() }),
    body: Joi.object({ quantity: Joi.number().integer().min(0).max(MAX_LINE_QUANTITY).required() }),
  },
  removeItem: {
    params: Joi.object({ workspaceId: workspaceIdParam, itemId: uuid.required() }),
  },
};
