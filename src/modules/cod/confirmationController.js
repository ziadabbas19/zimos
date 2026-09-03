'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./confirmationService');

const listQueue = asyncHandler(async (req, res) => res.json({ tasks: await service.listQueue(req.tenant.workspaceId, req.query) }));
const claim = asyncHandler(async (req, res) => res.json({ task: await service.claimTask(req.tenant.workspaceId, req.params.taskId, req.user.id) }));
const outcome = asyncHandler(async (req, res) => res.json({ task: await service.recordOutcome(req.tenant.workspaceId, req.params.taskId, req.body, req) }));

module.exports = { listQueue, claim, outcome };
