'use strict';

const db = require('../../db/models');
const orderLock = require('../orders/orderLock');

/**
 * Stored webhook deliveries and locked orders (orders/orderLock,
 * ORDERS_LOCK_ENABLED). A delivery's payload was written while what it is
 * about was visible; the order, the customer or the lost checkout may be
 * locked since. Then it is
 *   sent      never: not a retry still due, not Redeliver, not Resend
 *             (webhookDispatcher; the two buttons answer 402 ORDER_LOCKED);
 *   shown     in the delivery log with the customer's details as "••••", as
 *             the order itself shows, and `contactLocked: true`.
 * When it opens, the change scanner sends where the order stands
 * (orderChangeDetector.releaseHeld) and the stored row can be sent again.
 * Off, nothing is read and nothing changes.
 */

function subjectOf(delivery) {
  const data = (delivery.payload && delivery.payload.data) || {};
  return {
    orderId: (data.order && data.order.id) || data.orderId || null,
    customerId: data.customer && data.customer.id ? data.customer.id : null,
    checkout: String(delivery.eventType).startsWith('checkout.'),
  };
}

/** Refuses (402 ORDER_LOCKED) sending this delivery by hand while what it is about is locked now. */
async function assertSendable(workspaceId, delivery) {
  if (!orderLock.enabled()) return;
  const { orderId, customerId, checkout } = subjectOf(delivery);
  if (orderId) await orderLock.assertUnlocked(workspaceId, orderId);
  else if (customerId) await orderLock.assertCustomerVisible(workspaceId, customerId);
  else if (checkout) await orderLock.assertPendingOpen(workspaceId);
}

/** The ids of one store's deliveries whose subject is locked now: one read per kind, none while the switch is off. */
async function lockedIn(workspaceId, deliveries) {
  const locked = new Set();
  if (!orderLock.enabled() || deliveries.length === 0) return locked;
  const ctx = await orderLock.contextFor(workspaceId);
  if (orderLock.isOpenContext(ctx)) return locked;
  const subjects = deliveries.map((delivery) => [delivery, subjectOf(delivery)]);
  const orderIds = [...new Set(subjects.map(([, s]) => s.orderId).filter(Boolean))];
  const orders = orderIds.length ? await db.Order.findAll({ where: { id: orderIds, workspaceId }, attributes: orderLock.ORDER_ATTRIBUTES }) : [];
  const lockedOrders = await orderLock.lockedIds(ctx, orders);
  const lockedCustomers = await orderLock.lockedCustomerIds(ctx, workspaceId, subjects.map(([, s]) => s.customerId));
  const checkoutsHidden = orderLock.pendingLocked(ctx);
  for (const [delivery, s] of subjects) {
    const hidden = s.orderId ? lockedOrders.has(s.orderId) : s.customerId ? lockedCustomers.has(s.customerId) : s.checkout && checkoutsHidden;
    if (hidden) locked.add(delivery.id);
  }
  return locked;
}

const CONTACT_KEYS = new Set(['contact', 'contactSnapshot']);
const ADDRESS_KEYS = new Set(['shippingAddress', 'billingAddress', 'shippingAddressSnapshot', 'address']);
const TEXT_KEYS = new Set([
  'notes',
  'fullName',
  'firstName',
  'lastName',
  'customerName',
  'recipientName',
  'phone',
  'alternatePhone',
  'phoneNormalized',
  'phoneRaw',
  'phoneE164',
  'customerPhone',
  'email',
  'customerEmail',
  'ipAddress',
  'userAgent',
]);

/** A payload with the customer's details as "••••" at any depth (an empty field stays empty), as orderLock hides an order. */
function hide(value) {
  if (Array.isArray(value)) return value.map(hide);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    const object = inner && typeof inner === 'object' && !Array.isArray(inner);
    if (CONTACT_KEYS.has(key) && object) out[key] = orderLock.maskContact(inner);
    else if (ADDRESS_KEYS.has(key) && object) out[key] = orderLock.maskAddress(inner);
    else if (key === 'customer' && object) out[key] = orderLock.maskCustomer(inner);
    else if (key === 'savedAddresses' && Array.isArray(inner)) out[key] = inner.map((a) => orderLock.maskAddress(a));
    else if (TEXT_KEYS.has(key) && typeof inner === 'string' && inner !== '') out[key] = orderLock.MASK;
    else out[key] = hide(inner);
  }
  return out;
}

module.exports = { assertSendable, lockedIn, hide };
