'use strict';
const Joi = require('joi');
const uuid = Joi.string().uuid();
const taskParams = Joi.object({ workspaceId: uuid.required(), taskId: uuid.required() });

module.exports = {
  listQueue: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({
      // `queued` is the old name of `pending`, kept for clients that predate the tabs.
      status: Joi.string().valid('pending', 'queued', 'in_progress', 'done').default('pending'),
      mine: Joi.boolean().default(false),
      cursor: uuid.optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
    }),
  },
  counts: { params: Joi.object({ workspaceId: uuid.required() }) },
  claim: { params: taskParams },
  release: { params: taskParams },
  outcome: {
    params: taskParams,
    body: Joi.object({
      outcome: Joi.string().valid('confirmed', 'rejected', 'unreachable', 'postponed').required(),
      notes: Joi.string().max(1000).allow('').optional(),
      rejectionReason: Joi.string().max(300).when('outcome', { is: 'rejected', then: Joi.required() }),
    }),
  },
  correction: {
    params: taskParams,
    body: Joi.object({
      outcome: Joi.string().valid('confirmed', 'rejected').required(),
      reason: Joi.string().trim().min(1).max(300).required(),
      notes: Joi.string().max(600).allow('').optional(),
    }),
  },
};
