'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { subscribes } = require('./webhookEvents');
const { matchesFilter } = require('./webhookFilter');
const { DOMAIN_TO_TOPIC } = require('./webhookTopics');
const { capPayload } = require('./webhookPayloadCap');
const customerData = require('./customerData');

/**
 * Turns a domain event (core/outbox) into webhook deliveries: one row in
 * webhook_deliveries per endpoint that listens to the topic and whose filter
 * lets it through. The dispatcher (webhookDispatcher.js) sends them, with the
 * retries and the history every delivery gets.
 */

// Required lazily: the public order serializer pulls in the orders module.
const orders = () => require('../orders/orderService');
const serializers = () => require('../publicApi/publicOrderSerializer');
const orderAccepted = () => require('../orders/orderAccepted');

async function orderSubject(workspaceId, orderId) {
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['id', 'funnelId'] });
  if (!order) return null;
  const rows = await db.sequelize.query(
    `SELECT DISTINCT v.product_id AS "productId"
       FROM order_items i JOIN product_variants v ON v.id = i.variant_id
      WHERE i.order_id = :orderId`,
    { replacements: { orderId }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return { funnelId: order.funnelId, productIds: rows.map((r) => r.productId) };
}

const lock = () => require('../orders/orderLock');

/** The order as the public API sends it, or null while it is locked (orders/orderLock): nothing is sent then. */
async function orderData(workspaceId, orderId) {
  const order = await orders().getOrder(workspaceId, orderId);
  if (order.contactLocked) return null;
  const [serialized] = await require('../publicApi/publicOrderOptions').serializeOrders(workspaceId, [order]);
  return serialized;
}

/**
 * What a topic sends and what it is about. Null = the thing is gone, or its
 * customer's details are locked (orders/orderLock): send nothing, not even
 * try. A locked order's events are not sent later when it opens.
 */
async function build(topic, event) {
  const { workspaceId, payload } = event;
  const [aggregate] = topic.split('.');

  if (aggregate === 'order') {
    const subject = await orderSubject(workspaceId, payload.orderId);
    if (!subject) return null;
    const { orderId, workspaceId: _ws, ...extra } = payload;
    const order = await orderData(workspaceId, payload.orderId);
    if (!order) return null;
    return { subject, data: { order, ...extra } };
  }

  if (aggregate === 'shipment') {
    const shipment = await db.Shipment.findOne({ where: { id: payload.shipmentId, workspaceId } });
    if (!shipment) return null;
    const subject = (await orderSubject(workspaceId, shipment.orderId)) || {};
    return {
      subject,
      data: {
        orderId: shipment.orderId,
        old_status: payload.oldStatus || null,
        new_status: payload.newStatus || shipment.status,
        shipment: serializers().serializeShipment(shipment),
      },
    };
  }

  if (aggregate === 'product') {
    const product = await db.Product.findOne({
      where: { id: payload.productId, workspaceId },
      include: [{ model: db.ProductVariant, as: 'variants', required: false }],
      paranoid: false,
    });
    const { productId: _p, workspaceId: _w, ...extra } = payload;
    const data = { product: product ? product.toJSON() : { id: payload.productId }, ...extra };
    return { subject: { productIds: [payload.productId] }, data };
  }

  if (aggregate === 'funnel') {
    const funnel = await db.Funnel.findOne({ where: { id: payload.funnelId, workspaceId }, attributes: ['id', 'name', 'slug', 'status'] });
    if (!funnel) return null;
    return { subject: { funnelId: funnel.id }, data: { funnel: funnel.toJSON() } };
  }

  if (aggregate === 'customer' && payload.customerId) {
    const customer = await db.Customer.findOne({ where: { id: payload.customerId, workspaceId } });
    if (!customer) return null;
    const ctx = await lock().contextFor(workspaceId);
    if ((await lock().lockedCustomerIds(ctx, workspaceId, [customer.id])).size > 0) return null;
    return { subject: {}, data: { customer: customer.toJSON() } };
  }

  // A lost checkout carries what the shopper typed: not while new orders would be locked.
  if (aggregate === 'checkout' && lock().pendingLocked(await lock().contextFor(workspaceId))) return null;

  if (aggregate === 'review' && payload.reviewId) {
    const review = await db.Review.findOne({ where: { id: payload.reviewId, workspaceId } });
    if (!review) return null;
    return { subject: { productIds: review.productId ? [review.productId] : [] }, data: { review: review.toJSON() } };
  }

  // checkout.*, lead.created, contact_form.submitted: what the event recorded.
  return { subject: { funnelId: payload.funnelId || null, productIds: payload.productIds || [] }, data: payload };
}

/**
 * Queues `topic` for every listening endpoint of the workspace. `eventId` is
 * stable for one occurrence, so a retried job adds nothing twice (unique per
 * endpoint + event id). Returns how many deliveries were created.
 */
async function fanOut(workspaceId, topic, { eventId, data, subject = {}, endpointId = null, occurredAt = new Date() }) {
  const where = { workspaceId, isActive: true };
  if (endpointId) where.id = endpointId;
  const endpoints = (await db.WebhookEndpoint.findAll({ where })).filter((endpoint) => subscribes(endpoint, topic) && matchesFilter(endpoint, subject));
  const now = new Date();
  // Customers in full only for an endpoint whose configurer may see them (customerData.js).
  const reveals = await customerData.revealsByEndpoint(workspaceId, endpoints);
  const payload = { id: eventId, type: topic, createdAt: new Date(occurredAt).toISOString(), workspaceId, data };
  const rows = endpoints.map((endpoint) => ({
    workspaceId,
    endpointId: endpoint.id,
    eventId,
    eventType: topic,
    payload: capPayload(customerData.forEndpoint(payload, reveals.get(endpoint.id))),
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: now,
  }));
  if (rows.length === 0) return 0;
  await db.WebhookDelivery.bulkCreate(rows, { ignoreDuplicates: true });
  return rows.length;
}

/**
 * order.accepted (orders/orderAccepted.js) rides on two domain events: an
 * order that goes through confirmation is accepted when it is confirmed, one
 * paid online when it is paid. Each event checks that the order is accepted
 * now and in that way — so a cash-on-delivery order collected later, or a
 * manual transfer approved before its confirmation, sends nothing. The event
 * id is the order's: an endpoint hears it once per order, however many times
 * it is confirmed again.
 */
const ACCEPTED_VIA = { 'order.confirmed': 'confirmation', 'order.paid': 'payment' };

async function acceptedData(event, built) {
  const acceptance = await orderAccepted().acceptanceOf(event.workspaceId, event.payload.orderId);
  if (!acceptance || !acceptance.accepted || acceptance.via !== ACCEPTED_VIA[event.type]) return null;
  return { order: built.data.order, acceptedVia: acceptance.via, acceptedAt: acceptance.acceptedAt };
}

/** The outbox consumer: a domain event → its webhook topics, if it has any. */
async function handleDomainEvent(event) {
  const topics = [DOMAIN_TO_TOPIC[event.type], ACCEPTED_VIA[event.type] && 'order.accepted'].filter(Boolean);
  if (topics.length === 0 || !event.workspaceId) return 0;
  // Cheap way out for the many stores with no endpoint at all.
  const any = await db.WebhookEndpoint.findOne({ where: { workspaceId: event.workspaceId, isActive: true }, attributes: ['id'] });
  if (!any) return 0;
  // Every topic of one event is about the same thing (order.accepted only joins order.* ones): built once.
  const built = await build(topics[0], event);
  if (!built) return 0;
  let deliveries = 0;
  for (const topic of topics) {
    const accepted = topic === 'order.accepted';
    const data = accepted ? await acceptedData(event, built) : built.data;
    if (!data) continue;
    deliveries += await fanOut(event.workspaceId, topic, {
      eventId: accepted ? `order.accepted:${event.payload.orderId}` : `${topic}:${event.id || crypto.randomUUID()}`,
      data,
      subject: built.subject,
      occurredAt: event.occurredAt,
    });
  }
  return deliveries;
}

/**
 * "Resend to webhook": the orders as they are now, sent again as
 * `order.created` with `resent: true`, to one endpoint or to every endpoint
 * that listens to new orders. A fresh event id each time, so a receiver that
 * dedupes on it takes the copy.
 */
async function resendOrders(workspaceId, orderIds, { endpointId = null } = {}) {
  let deliveries = 0;
  const missing = [];
  // Locked orders (orders/orderLock) are not sent: named back so the screen can say why.
  const locked = [];
  for (const orderId of orderIds) {
    const subject = await orderSubject(workspaceId, orderId);
    if (!subject) {
      missing.push(orderId);
      continue;
    }
    const order = await orderData(workspaceId, orderId);
    if (!order) {
      locked.push(orderId);
      continue;
    }
    deliveries += await fanOut(workspaceId, 'order.created', {
      eventId: `order.created:${orderId}:resend:${crypto.randomUUID()}`,
      data: { order, resent: true },
      // A resend is an explicit request: the endpoint's filter is not applied
      // when the merchant named the endpoint.
      subject: endpointId ? {} : subject,
      endpointId,
    });
  }
  return { orders: orderIds.length - missing.length - locked.length, deliveries, missing, ...(locked.length ? { locked } : {}) };
}

module.exports = { fanOut, handleDomainEvent, resendOrders, orderSubject };
