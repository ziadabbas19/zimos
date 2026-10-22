'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./storefrontEventsService');
const { clientIp: clientIpOf } = require('../../core/middleware/clientIp');

// 202: the batch is accepted; nothing about it is echoed back beyond the count
// (and `bot: true` when the User-Agent is a known crawler and nothing was stored).
const ingest = asyncHandler(async (req, res) => {
  const result = await service.ingest(req.tenant.workspaceId, req.body, {
    userAgent: req.get('user-agent'),
    getHeader: (name) => req.get(name),
    // Set by the events guard (traffic/trafficGuard.js) only while it is on.
    guard: req.trafficGuard || null,
  });
  // Conversion events also go to the store's server-side pixels (queued; never delays or fails this answer).
  // Not for a session the guard keeps out of the numbers: its conversions are not a person's.
  if (!result.bot && !result.excluded) void require('../marketing/browserEventRelay').relay(req.tenant.workspaceId, req.body, { clientIp: clientIpOf(req), userAgent: req.get('user-agent') });
  res.status(202).json(result.bot ? { accepted: result.accepted, bot: true } : { accepted: result.accepted });
});

module.exports = { ingest };
