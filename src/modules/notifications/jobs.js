'use strict';

const merchantNotificationEvents = require('./merchantNotificationEvents');
const orderEmailService = require('./orderEmailService');

const DAY = 24 * 60 * 60 * 1000;

/** The dashboard bell, fed by the outbox (core/outbox). */
module.exports = {
  schedules: [
    {
      // Device notifications (push/): devices of ended sessions, and devices
      // unseen for 60 days, removed. Nothing while PUSH_ENABLED is off.
      name: 'push.cleanup',
      everyMs: DAY,
      // eslint-disable-next-line global-require
      handle: () => require('./push/pushService').cleanup(),
    },
  ],
  consumers: [
    {
      name: 'merchant_notifications',
      queue: 'notifications',
      events: ['order.created'],
      handle: (event) => merchantNotificationEvents.orderCreated(event.workspaceId, event.payload.orderId),
    },
    {
      // The store's own emails to its customers (orderEmailService.js): sent only for templates the merchant switched on.
      name: 'order_emails',
      queue: 'notifications',
      events: orderEmailService.EVENTS,
      handle: (event) => orderEmailService.handleEvent(event.workspaceId, event.type, event.payload),
    },
  ],
};
