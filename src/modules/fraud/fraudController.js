'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./fraudService');
const blockedEntries = require('./blockedEntries');
const protectionActions = require('./protectionActions');

const listFlagged = asyncHandler(async (req, res) =>
  // Phones masked for roles without customers.reveal_sensitive; the order page shows the full one.
  res.json(require('../../core/utils/phoneMask').forViewer(req, await service.listFlaggedOrders(req.tenant.workspaceId, req.query)))
);
const approve = asyncHandler(async (req, res) =>
  res.json({ order: await service.approveFlaggedOrder(req.tenant.workspaceId, req.params.orderId, req) })
);
const listBlocklist = asyncHandler(async (req, res) =>
  res.json(await blockedEntries.listEntries(req.tenant.workspaceId, req.query))
);
// The older body ({ phone, reason, fullName }) is still accepted: a phone, for orders.
const block = asyncHandler(async (req, res) => {
  const { phone, fullName, ...rest } = req.body;
  const { created, entries } = await blockedEntries.addEntry(
    req.tenant.workspaceId,
    { ...rest, value: rest.value !== undefined ? rest.value : phone },
    req
  );
  res.status(created ? 201 : 200).json({ entry: entries[0], entries });
});
const unblock = asyncHandler(async (req, res) =>
  res.json(await blockedEntries.removeEntry(req.tenant.workspaceId, req.params.entryId, req))
);
const importBlocklist = asyncHandler(async (req, res) =>
  res.json(await blockedEntries.importCsv(req.tenant.workspaceId, req.body, req))
);

const blockAndCancel = asyncHandler(async (req, res) =>
  res.json(await protectionActions.blockAndCancel(req.tenant.workspaceId, req.params.orderId, req.body || {}, req))
);
const stats = asyncHandler(async (req, res) => res.json(await protectionActions.stats(req.tenant.workspaceId, req.query)));
const capabilities = (req, res) => res.json(require('./capabilities').protectionCapabilities());

module.exports = { listFlagged, approve, listBlocklist, block, unblock, importBlocklist, blockAndCancel, stats, capabilities };
