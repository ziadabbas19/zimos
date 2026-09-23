'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./checkoutSessionService');

// Public: echoes nothing back but the id the storefront needs to send with
// its checkout. The rest is the shopper's own input or catalogue data.
const capture = asyncHandler(async (req, res) => {
  const session = await service.capture(req.tenant.workspaceId, req.body);
  res.json({ session: { id: session.id } });
});

const list = asyncHandler(async (req, res) => {
  res.json(await service.listSessions(req.tenant.workspaceId, req.query));
});

const update = asyncHandler(async (req, res) => {
  const session = await service.updateRecoveryStatus(req.tenant.workspaceId, req.params.sessionId, req.body, req);
  res.json({ session });
});

module.exports = { capture, list, update };
