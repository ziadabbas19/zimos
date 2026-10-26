'use strict';

const env = require('../../config/env');

const MINUTE = 60 * 1000;

const RETENTION = {
  // zimos.co visits past SITE_VISITS_RETENTION_DAYS (siteVisitsRetention.js).
  name: 'site_analytics.visits_retention',
  everyMs: 6 * 60 * MINUTE,
  // eslint-disable-next-line global-require
  handle: () => require('./siteVisitsRetention').run(),
};

module.exports = {
  // Only while SITE_VISITS_RETENTION_DAYS is set: unset, the worker registers
  // no schedule for it (no queue_schedules row), as before.
  get schedules() {
    return env.siteVisitsRetentionDays > 0 ? [RETENTION] : [];
  },
};
