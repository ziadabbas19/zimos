'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();
const workspaceIdParam = Joi.alternatives().try(uuid, Joi.string().pattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)).required();

module.exports = {
  listProducts: {
    params: Joi.object({ workspaceId: workspaceIdParam }),
    query: Joi.object({
      collectionId: uuid.optional(),
      tag: Joi.string().max(100).optional(),
      search: Joi.string().max(200).optional(),
      limit: Joi.number().integer().min(1).max(100).default(24),
      cursor: uuid.optional(),
    }),
  },
  getProduct: {
    params: Joi.object({ workspaceId: workspaceIdParam, idOrSlug: Joi.string().max(300).required() }),
  },
  workspaceParam: { params: Joi.object({ workspaceId: workspaceIdParam }) },
  getCollection: { params: Joi.object({ workspaceId: workspaceIdParam, collectionId: uuid.required() }) },
};
