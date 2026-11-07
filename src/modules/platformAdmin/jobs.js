'use strict';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// eslint-disable-next-line global-require
const consolePush = () => require('./consolePush');

module.exports = {
  schedules: [
    {
      // Console notifications for subscriptions ending within 7 days or just
      // ended (platformNotificationService.sweepSubscriptions).
      name: 'platform_notifications.subscription_sweep',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./platformNotificationService').sweepSubscriptions(),
    },
    {
      // What already reached each console account's devices, older than 3 days, is forgotten (consolePush.js). Nothing while push is off.
      name: 'console_push.forget_sent',
      everyMs: DAY,
      handle: () => consolePush().forgetSent(),
    },
  ],
  processors: [
    // A console notification, sent to the devices of the accounts its bell shows it to (consolePush.js).
    { queue: 'notifications', name: 'console_push.send', handle: (job) => consolePush().send(job.payload.notificationId) },
  ],
};
