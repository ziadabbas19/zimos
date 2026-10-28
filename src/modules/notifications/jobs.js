'use strict';

const merchantNotificationEvents = require('./merchantNotificationEvents');
const orderEmailService = require('./orderEmailService');
const pushConfig = require('./push/pushConfig');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// eslint-disable-next-line global-require
const pushDigest = () => require('./push/pushDigest');

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
    {
      // Gathered device notifications whose queued send was lost are sent (push/pushDigest.js). Nothing while off.
      name: 'push.flush_overdue',
      everyMs: 5 * MINUTE,
      handle: () => pushDigest().flushOverdue(),
    },
  ],
  processors: [
    // The end of a window: the gathered device notifications go as one (push/pushDigest.js).
    { queue: 'notifications', name: 'push.flush', handle: (job) => pushDigest().flush(job.payload.digestId) },
    // One device the push service asked to come back to.
    { queue: 'notifications', name: 'push.resend', handle: (job) => pushDigest().resend(job.payload) },
  ],
  consumers: [
    {
      name: 'merchant_notifications',
      queue: 'notifications',
      events: ['order.created'],
      handle: (event) => merchantNotificationEvents.orderCreated(event.workspaceId, event.payload.orderId),
    },
    {
      // The notifications that came with device notifications (merchantNotificationEvents.orderPaid,
      // lostOrderCreated). Its events are read at each dispatch (core/outbox consumersFor): while
      // push is off it asks for none, so no job is queued for it, as before it existed.
      name: 'merchant_push_notifications',
      queue: 'notifications',
      get events() {
        return pushConfig.isOn() ? ['order.paid', 'lost_order.created'] : [];
      },
      handle: (event) =>
        event.type === 'order.paid'
          ? merchantNotificationEvents.orderPaid(event.workspaceId, event.payload.orderId)
          : merchantNotificationEvents.lostOrderCreated(event.workspaceId, event.payload.checkoutSessionId),
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
