'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();

module.exports = {
  listQueue: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ status: Joi.string().valid('queued', 'in_progress', 'done').default('queued'), limit: Joi.number().integer().min(1).max(200).default(50) }),
  },
  claim: { params: Joi.object({ workspaceId: uuid.required(), taskId: uuid.required() }) },
  outcome: {
    params: Joi.object({ workspaceId: uuid.required(), taskId: uuid.required() }),
    body: Joi.object({
      outcome: Joi.string().valid('confirmed', 'rejected', 'unreachable', 'postponed').required(),
      notes: Joi.string().max(1000).allow('').optional(),
      rejectionReason: Joi.string().max(300).when('outcome', { is: 'rejected', then: Joi.required() }),
    }),
  },
};
