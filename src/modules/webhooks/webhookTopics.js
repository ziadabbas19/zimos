'use strict';

/**
 * The webhook topics beyond order.created / order.status_changed (SPEC §16.1).
 *
 * Those two come from the order change detector. Everything here comes from
 * the event outbox (core/outbox): a domain event is turned into a webhook
 * event by jobs.js → webhookFanout.js. DOMAIN_TO_TOPIC names which domain
 * event feeds which topic; a domain event not listed sends nothing.
 */

const TOPICS = Object.freeze({
  'order.updated': "An order's contact, address or notes were edited.",
  'order.confirmed': 'A cash-on-delivery order was confirmed with the customer.',
  'order.fulfilled': 'An order was delivered to the customer.',
  'order.cancelled': 'An order was cancelled.',
  'order.uncancelled': 'A cancelled order was reopened.',
  'order.paid': 'An order was paid in full.',
  // Fed by order.confirmed and order.paid (webhookFanout.js, orders/orderAccepted.js); not in '*'.
  'order.accepted':
    "An order was accepted: a cash-on-delivery or manually paid order was confirmed, or an online order was paid. Sent once per order, with acceptedVia and acceptedAt. Only to endpoints that list it: '*' does not include it.",
  'order.refunded': 'An order was refunded, fully or in part.',
  'order.item_added': 'A product was added to an order after it was placed (an upsell, or an edit by the team).',
  'shipment.status_changed': 'A shipment moved to another status (old_status and new_status are in the payload).',
  'checkout.created': 'A shopper started a checkout.',
  'checkout.updated': 'A shopper changed their checkout details.',
  'checkout.abandoned': 'A checkout was left without an order.',
  'customer.created': 'A new customer was recorded.',
  'customer.updated': "A customer's details were edited.",
  'lead.created': 'A new lead was captured.',
  'contact_form.submitted': 'A contact form was submitted.',
  'product.created': 'A product was added.',
  'product.updated': 'A product was edited.',
  'product.deleted': 'A product was archived.',
  'product.low_stock': "A variant's available stock fell to its low-stock threshold (variantId, available and threshold are in the payload).",
  'review.created': 'A product review was submitted by a customer or added by the team.',
  'funnel.published': 'A funnel was published.',
});

const DOMAIN_TO_TOPIC = Object.freeze({
  'order.updated': 'order.updated',
  'order.confirmed': 'order.confirmed',
  'order.delivered': 'order.fulfilled',
  'order.cancelled': 'order.cancelled',
  'order.uncancelled': 'order.uncancelled',
  'order.paid': 'order.paid',
  'order.refunded': 'order.refunded',
  'order.item_added': 'order.item_added',
  'shipment.status_changed': 'shipment.status_changed',
  'checkout.started': 'checkout.created',
  'checkout.created': 'checkout.created',
  'checkout.updated': 'checkout.updated',
  'checkout.abandoned': 'checkout.abandoned',
  'customer.created': 'customer.created',
  'customer.updated': 'customer.updated',
  'lead.created': 'lead.created',
  'contact_form.submitted': 'contact_form.submitted',
  'product.created': 'product.created',
  'product.updated': 'product.updated',
  'product.deleted': 'product.deleted',
  'product.low_stock': 'product.low_stock',
  'review.created': 'review.created',
  'funnel.published': 'funnel.published',
});

module.exports = { TOPICS, DOMAIN_TO_TOPIC };
