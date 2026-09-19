'use strict';

const env = require('../../config/env');
const db = require('../../db/models');
const { probeStorage } = require('../media/storage');
const brevo = require('../notifications/brevoEmailProvider');
const twilio = require('../notifications/twilioSmsProvider');

/**
 * Live health tiles for the platform admin console.
 *
 * Four statuses, and the distinction between the last two is the whole point
 * of this endpoint:
 *
 *   operational     probed successfully
 *   degraded        works, but something about it should not be left alone
 *   down            configured, probed, failed
 *   not_configured  deliberately switched off here — neutral, NOT an error
 *
 * These four strings are the console's shared status vocabulary and must be
 * spelled exactly: its badge maps status -> colour through a lookup with a
 * neutral fallback, so an unrecognised value (`ok`, say) does not throw or
 * log — a perfectly healthy service just renders grey forever. Never send
 * `unknown`; that one is reserved for the browser's own fallback, which
 * cannot tell a down service from a blocked request. A probe we ran always
 * has a real outcome.
 *
 * A tile never reports `operational` for something it did not actually reach. An
 * integration that is off reports `not_configured`, because a green check next
 * to a service that does not exist is worse than no tile at all.
 */

// Every probe is bounded: the endpoint's worst case is one timeout, not five
// in series, because they run in parallel.
const PROBE_TIMEOUT_MS = 5000;
// A probe that succeeds but takes longer than this is reported as degraded.
const SLOW_MS = 2000;
// GET serves a recent result rather than firing real third-party requests on
// every page load and refresh; POST /check always bypasses this.
const CACHE_TTL_MS = 30000;

// Payment providers that live in this process and have no third party behind
// them, so there is nothing a probe could reach.
const IN_PROCESS_PAYMENT_PROVIDERS = new Set(['mock', 'cod']);

let cache = null;

function tile(key, name, status, extra = {}) {
  return {
    key,
    name,
    status,
    latencyMs: extra.latencyMs ?? null,
    detail: extra.detail ?? null,
    // Stamped when THIS probe ran, not when the response is served. A cache
    // hit returns the tile untouched, so the console can render it as a
    // relative time and have it mean something.
    checkedAt: new Date().toISOString(),
    // v1 has no service_checks table to derive history from. Null rather than
    // a fabricated 100% — the console hides these rows instead of showing a
    // number nobody measured.
    uptime30d: null,
    lastIncidentAt: null,
    lastIncidentSummary: null,
  };
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs one probe and turns whatever happens into a tile. A probe may throw, or
 * hang — neither is allowed to fail the request, because a services page that
 * 500s when a service is down is useless exactly when it is needed.
 */
async function runProbe({ key, name, skip, run }) {
  const reason = skip ? skip() : null;
  if (reason) return tile(key, name, 'not_configured', { detail: reason });

  const startedAt = Date.now();
  try {
    const result = (await withTimeout(run(), name)) || {};
    const latencyMs = Date.now() - startedAt;
    const status = result.status || (latencyMs > SLOW_MS ? 'degraded' : 'operational');
    return tile(key, name, status, { latencyMs, detail: result.detail ?? null });
  } catch (err) {
    return tile(key, name, 'down', {
      latencyMs: Date.now() - startedAt,
      // The probe's own message, which is the useful part — never a stack.
      detail: err.message,
    });
  }
}

const PROBES = [
  {
    key: 'postgres',
    name: 'Database',
    // No skip: the API cannot serve this request at all without Postgres, so
    // it is never "not configured".
    run: async () => {
      await db.sequelize.query('SELECT 1');
      const { host, database } = db.sequelize.config;
      return { detail: `${database} at ${host}` };
    },
  },
  {
    key: 'storage',
    name: 'Media storage',
    run: async () => {
      const result = await probeStorage();
      // Local disk works, but on a container filesystem it is erased by the
      // next deploy. That is worth a warning even though the probe passed.
      if (env.storage.provider !== 'r2' && env.isProduction) {
        return {
          status: 'degraded',
          detail: 'local disk on an ephemeral filesystem — uploads will not survive a redeploy (set STORAGE_PROVIDER=r2)',
        };
      }
      return result;
    },
  },
  {
    key: 'email',
    name: 'Email (Brevo)',
    skip: () =>
      env.notifications.emailProvider !== 'brevo'
        ? `EMAIL_PROVIDER=${env.notifications.emailProvider} — Brevo is not in use here`
        : null,
    run: () => brevo.probe({ timeoutMs: PROBE_TIMEOUT_MS }),
  },
  {
    key: 'sms',
    name: 'SMS (Twilio)',
    skip: () =>
      env.notifications.smsProvider !== 'twilio'
        ? `SMS_PROVIDER=${env.notifications.smsProvider} — Twilio is not in use here`
        : null,
    run: () => twilio.probe(),
  },
  {
    key: 'payments',
    name: 'Payment gateway',
    // There is no real gateway in this backend yet: `mock` and `cod` both run
    // in-process and talk to nothing. Reporting `ok` here would put a green
    // check next to a payment gateway that does not exist.
    skip: () => {
      const provider = env.payments.defaultProvider;
      return IN_PROCESS_PAYMENT_PROVIDERS.has(provider)
        ? `PAYMENTS_DEFAULT_PROVIDER=${provider} — handled in-process, no external gateway to reach`
        : `no health probe implemented for payment provider "${provider}"`;
    },
    run: async () => ({}),
  },
];

async function runAll() {
  // In parallel: five sequential probes would make the page wait for the sum
  // of five timeouts in the worst case.
  return Promise.all(PROBES.map(runProbe));
}

/**
 * GET /admin/system/services — a recent reading, re-probed at most every
 * CACHE_TTL_MS so refreshing the page does not fire real requests at Brevo and
 * Twilio each time.
 */
async function listServices() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { services: cache.services, cached: true };
  }
  const services = await runAll();
  cache = { at: Date.now(), services };
  return { services, cached: false };
}

/**
 * POST /admin/system/services/check — always probes for real. Same envelope
 * and same tile shape as the GET so the console keeps one rendering path.
 */
async function checkServices() {
  const services = await runAll();
  cache = { at: Date.now(), services };
  return { services, cached: false };
}

// Lets tests start from a known state rather than a neighbour's reading.
function _resetCache() {
  cache = null;
}

module.exports = { listServices, checkServices, _resetCache, PROBE_TIMEOUT_MS, CACHE_TTL_MS };
