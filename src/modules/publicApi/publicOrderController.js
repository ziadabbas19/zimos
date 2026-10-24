'use strict';

const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const service = require('./publicOrderService');
const feed = require('./acceptedOrdersFeed');
const pos = require('./posStatus');
const { forViewer } = require('../../core/utils/phoneMask');

const wid = (req) => req.tenant.workspaceId;

/** Which store and what this key may do — the first call an integration makes. */
const me = asyncHandler(async (req, res) => {
  res.json({
    workspaceId: wid(req),
    apiKey: { id: req.apiKey.id, name: req.apiKey.name, keyPrefix: req.apiKey.keyPrefix, scopes: req.apiKey.scopes },
    actingAs: { id: req.user.id, fullName: req.user.fullName },
  });
});

/**
 * The list filters under the names integrations expect (SPEC §16.2), mapped
 * onto the dashboard's: status → stage, created_from/created_to → from/to,
 * updated_since → updatedSince, product_id → productId.
 */
const ALIASES = { status: 'stage', created_from: 'from', created_to: 'to', updated_since: 'updatedSince', product_id: 'productId' };
function listAliases(req, res, next) {
  const query = { ...req.query };
  for (const [alias, name] of Object.entries(ALIASES)) {
    if (query[alias] !== undefined && query[name] === undefined) query[name] = query[alias];
    delete query[alias];
  }
  // Express 5: req.query is a getter, so it is redefined rather than assigned.
  Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
  next();
}

// Phones in the list are masked unless the key may see them: its creator holds
// customers.reveal_sensitive and the key carries customers:read (as the dashboard list).
const list = asyncHandler(async (req, res) => res.json(forViewer(req, await service.listOrders(wid(req), req.query))));

const get = asyncHandler(async (req, res) => res.json({ order: await service.getOrder(wid(req), req.params.orderId) }));

const getByNumber = asyncHandler(async (req, res) =>
  res.json({ order: await service.getOrderByNumber(wid(req), req.params.orderNumber) })
);

const listShipments = asyncHandler(async (req, res) =>
  res.json({ shipments: await service.listShipments(wid(req), req.params.orderId) })
);

const confirmation = asyncHandler(async (req, res) =>
  res.json({ order: await service.setConfirmation(wid(req), req.params.orderId, req.body, req) })
);

const cancel = asyncHandler(async (req, res) =>
  res.json({ order: await service.cancelOrder(wid(req), req.params.orderId, req.body, req) })
);

const createShipment = asyncHandler(async (req, res) =>
  res.status(201).json({ shipment: await service.createShipment(wid(req), req.params.orderId, req.body, req) })
);

const updateShipment = asyncHandler(async (req, res) =>
  res.json({
    shipment: await service.updateShipment(wid(req), req.params.orderId, req.params.shipmentId, req.body, req),
  })
);

// Safe to repeat without an Idempotency-Key: a paid order is left as it is.
const codCollected = asyncHandler(async (req, res) =>
  res.json({ order: await service.markCodCollected(wid(req), req.params.orderId, req) })
);

// PUBLIC_API_ACK_ENABLED (acceptedOrdersFeed.js, posStatus.js). The feed masks
// phones as the orders list does — a convenience, not a boundary: the same
// key reads one order (GET /orders/:id) with the full number, and names,
// emails and addresses are never masked. What a key may read is decided by
// its scopes and its creator's role.
// An ETag of what the till would take (the orders, their versions, the
// cursor): a till that sends it back as If-None-Match while nothing changed
// gets 304 and no body. `since` moves with the clock and is left out of it.
const accepted = asyncHandler(async (req, res) => {
  const body = forViewer(req, await feed.listUnacked(wid(req), req.apiKey, req.query));
  const version = JSON.stringify([body.orders.map((o) => [o.id, o.updatedAt, o.pos ? o.pos.updatedAt : null]), body.nextCursor]);
  res.set('ETag', `W/"${crypto.createHash('sha256').update(version).digest('base64url').slice(0, 27)}"`);
  res.set('Cache-Control', 'no-cache');
  res.json(body);
});

const ack = asyncHandler(async (req, res) => res.json(await feed.acknowledge(wid(req), req.apiKey, req.body.orderIds)));

const ackOne = asyncHandler(async (req, res) => res.json({ ack: await feed.acknowledgeOne(wid(req), req.apiKey, req.params.orderId) }));

const posStatus = asyncHandler(async (req, res) => res.json({ pos: await pos.setStatus(wid(req), req.params.orderId, req.body, req) }));

module.exports = { listAliases, me, list, get, getByNumber, listShipments, confirmation, cancel, createShipment, updateShipment, codCollected, accepted, ack, ackOne, posStatus };
