'use strict';

/**
 * Every event an endpoint can subscribe to. An endpoint's `events` lists the
 * names it wants, or '*' for all of them (including ones added later).
 *
 * `webhook.test` is not subscribable: it is sent only when the merchant
 * presses "Send test" on one endpoint, whatever that endpoint listens to.
 */
const EVENT_TYPES = Object.freeze({
  'order.created': 'A new order was placed.',
  'order.status_changed':
    "An order's stage, confirmation, payment or fulfilment state changed, or its shipment moved (shipped, out for delivery, delivered, returned…).",
  // The topics fed by the event outbox (webhookTopics.js).
  ...require('./webhookTopics').TOPICS,
});
const EVENT_NAMES = Object.keys(EVENT_TYPES);
const WILDCARD = '*';
const TEST_EVENT = 'webhook.test';

// Sent only to endpoints that name them: an endpoint on '*' before they existed
// would otherwise start receiving a second event for the same order change.
const EXPLICIT_ONLY = new Set(['order.accepted']);

function subscribes(endpoint, eventType) {
  const events = endpoint.events || [];
  return events.includes(eventType) || (events.includes(WILDCARD) && !EXPLICIT_ONLY.has(eventType));
}

module.exports = { EVENT_TYPES, EVENT_NAMES, WILDCARD, TEST_EVENT, EXPLICIT_ONLY, subscribes };
