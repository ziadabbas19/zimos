'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  schedules: [
    {
      // zimos.co visits past SITE_VISITS_RETENTION_DAYS (siteVisitsRetention.js). Off by default.
      name: 'site_analytics.visits_retention',
      everyMs: 6 * 60 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./siteVisitsRetention').run(),
    },
  ],
};
