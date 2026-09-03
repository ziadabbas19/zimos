'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { ALL_PERMISSIONS } = require('../../core/security/permissions');

const uuid = Joi.string().uuid();

module.exports = {
  create: { body: Joi.object({ name: Joi.string().min(2).max(200).required() }) },
  invite: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ email: joiEmail().required(), roleId: uuid.required() }),
  },
  listMembers: { params: Joi.object({ workspaceId: uuid.required() }) },
  resendInvite: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
  },
  updateRole: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
    body: Joi.object({ roleId: uuid.required() }),
  },
  removeMember: {
    params: Joi.object({ workspaceId: uuid.required(), membershipId: uuid.required() }),
  },
  createRole: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      name: Joi.string().min(2).max(100).required(),
      key: Joi.string().min(2).max(64).pattern(/^[a-z0-9_]+$/).required(),
      permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)).min(1).required(),
    }),
  },
};
