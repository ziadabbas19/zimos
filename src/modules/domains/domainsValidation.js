'use strict';

const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  add: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ hostname: Joi.string().min(4).max(255).required() }),
  },
  list: { params: Joi.object({ workspaceId: uuid.required() }) },
  verify: {
    params: Joi.object({ workspaceId: uuid.required(), domainId: uuid.required() }),
  },
  remove: {
    params: Joi.object({ workspaceId: uuid.required(), domainId: uuid.required() }),
  },
};
