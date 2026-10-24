'use strict';

const { PERMISSIONS } = require('../../core/security/permissions');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');

/**
 * What the live updates send, and to whom (modules/realtime).
 *
 * Each outbox event below becomes one socket message under its own name. A
 * store's message goes to the room of the permission that opens what it is
 * about, in that store only; a console message goes to the room of the
 * console permission of the page it points at (the same permission as the
 * console bell's type for it). The room comes from the event row the server
 * wrote in the change's own transaction, never from anything a client sent.
 *
 * A message carries ids only (route() below): no name, phone, address,
 * amount, order number or note. The client asks the API for the rest, which
 * checks its permissions as for any other request.
 *
 * `entity` names what the client should fetch again: the order for an
 * order's or its shipment's change, the product for its low stock.
 */
const STORE = Object.freeze({
  'order.created': { name: 'order.created', permission: PERMISSIONS.ORDERS_VIEW, entity: (p) => ['order', p.orderId] },
  'order.paid': { name: 'order.paid', permission: PERMISSIONS.ORDERS_VIEW, entity: (p) => ['order', p.orderId] },
  // Recorded for the live updates only (orders/orderStatusHistory.sync): a move between pipeline stages.
  'order.stage_changed': { name: 'order.status_changed', permission: PERMISSIONS.ORDERS_VIEW, entity: (p) => ['order', p.orderId] },
  'shipment.status_changed': { name: 'shipment.status', permission: PERMISSIONS.ORDERS_VIEW, entity: (p) => ['order', p.orderId] },
  'product.low_stock': { name: 'stock.low', permission: PERMISSIONS.INVENTORY_VIEW, entity: (p) => ['product', p.productId] },
});

// Recorded for the live updates only (realtimeEvents.js).
const CONSOLE = Object.freeze({
  'merchant.created': { name: 'merchant.created', permission: P.WORKSPACES_VIEW, entity: (p) => ['user', p.userId] },
  'subscription.paid': { name: 'subscription.paid', permission: P.SUBSCRIPTIONS_VIEW, entity: (p) => ['billing_invoice', p.billingInvoiceId] },
  'ticket.created': { name: 'ticket.created', permission: P.SUPPORT_VIEW, entity: (p) => ['support_ticket', p.ticketId] },
});

const EVENTS = Object.freeze([...Object.keys(STORE), ...Object.keys(CONSOLE)]);

// The permissions that have a room. A socket joins no other.
const STORE_PERMISSIONS = Object.freeze([...new Set(Object.values(STORE).map((e) => e.permission))]);
const CONSOLE_PERMISSIONS = Object.freeze([...new Set(Object.values(CONSOLE).map((e) => e.permission))]);

const userRoom = (userId) => `u:${userId}`;
const storeRoom = (workspaceId, permission) => `w:${workspaceId}:${permission}`;
const consoleRoom = (permission) => `p:${permission}`;

/** The room and message for an outbox event; null when it sends nothing. */
function route(event) {
  const store = STORE[event.type];
  const entry = store || CONSOLE[event.type];
  if (!entry) return null;
  if (store && !event.workspaceId) return null;
  const [type, id] = entry.entity(event.payload || {});
  if (!id) return null;
  return {
    room: store ? storeRoom(event.workspaceId, entry.permission) : consoleRoom(entry.permission),
    name: entry.name,
    message: {
      v: 1,
      id: event.id || null,
      type: entry.name,
      workspaceId: event.workspaceId || null,
      entity: { type, id: String(id) },
      at: new Date(event.occurredAt || Date.now()).toISOString(),
    },
  };
}

module.exports = { STORE, CONSOLE, EVENTS, STORE_PERMISSIONS, CONSOLE_PERMISSIONS, userRoom, storeRoom, consoleRoom, route };
