'use strict';

const env = require('../../../config/env');

/**
 * The thresholds of the storefront events guard, in one place. Every number
 * here is a constant on purpose: changing one is a reviewed commit, not an
 * environment typo. Only the daily cap per store has an override
 * (TRAFFIC_STORE_DAILY_CAP), because it is the one tied to cost.
 *
 * Counted in each API process's memory (like the other limiters without
 * RATE_LIMIT_REDIS): with N processes the per-minute limits are N times these.
 * Not frozen: a test lowers one on the object and puts it back.
 */
const LIMITS = {
  WINDOW_MS: 60 * 1000,
  // Events (not requests) per minute. An IP is shared by many shoppers on a
  // mobile carrier, so it gets the most room; one visitor (one tab) the least.
  EVENTS_PER_IP_MINUTE: 1200,
  EVENTS_PER_VISITOR_MINUTE: 150,
  EVENTS_PER_STORE_MINUTE: 12000,
  // A request body while the guard is on (64kb without it), and events in one
  // request — the Joi schema refuses more than this, the tracker sends at most this.
  MAX_BODY_BYTES: 32 * 1024,
  MAX_EVENTS_PER_REQUEST: 20,
  // The same visitor, event name and page within this window counts once.
  DEDUPE_MS: 1000,
  // More page views than this by one visitor in one minute is not a person.
  PAGES_PER_MINUTE: 50,
  // A visible time longer than this on one page view is not believed, and one
  // longer than the time between the page view and the report (plus this
  // tolerance, for the batching delay) flags the session.
  MAX_DWELL_MS: 4 * 60 * 60 * 1000,
  DWELL_TOLERANCE_MS: 30 * 1000,
  // How often the counters reach the database, and how many distinct keys of
  // what was kept out one flush writes at most (the rest is summed as "other").
  FLUSH_MS: 15 * 1000,
  MAX_FILTER_KEYS_PER_FLUSH: 300,
  // Retention of what the guard keeps for review (analytics/jobs.js purge).
  QUARANTINE_DAYS: 14,
  FILTER_DAYS: 30,
  SALT_KEEP_DAYS: 2,
};

/** TRAFFIC_GUARD_ENABLED; read on every request so a test can flip it on the env object. */
const guardEnabled = () => Boolean(env.trafficGuard && env.trafficGuard.enabled);

/** off | report | enforce (TRAFFIC_ORIGIN_CHECK). */
const originMode = () => (env.trafficGuard && env.trafficGuard.originCheck) || 'off';

const storeDailyCap = () => (env.trafficGuard && env.trafficGuard.storeDailyCap) || 100000;

module.exports = { LIMITS, guardEnabled, originMode, storeDailyCap };
