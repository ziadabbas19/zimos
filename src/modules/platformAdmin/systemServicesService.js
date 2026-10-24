'use strict';

const env = require('../../config/env');
const db = require('../../db/models');
const { probeStorage, storageProblems, describeStorage } = require('../media/storage');
const brevo = require('../notifications/brevoEmailProvider');
const twilio = require('../notifications/twilioSmsProvider');
const gateways = require('../payments/gateways');
const providerRegistry = require('./providerRegistryService');

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
      // The probe passing says the backend answers; the links it hands out can
      // still be wrong (R2_PUBLIC_URL, APP_URL) or short-lived (local disk in
      // production with no volume). Either is worth a warning. The detail
      // always names the active driver and the public base URL, no secrets.
      const problems = storageProblems();
      const summary = describeStorage();
      if (problems.length) return { status: 'degraded', detail: `${summary} — ${problems.join('; ')}` };
      return { ...result, detail: `${result.detail} — ${summary}` };
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
    name: 'Payment gateways',
    // Online payments are off unless PAYMENTS_ONLINE_ENABLED says otherwise,
    // and off is a deliberate setting, not a failure. PAYMENTS_DEFAULT_PROVIDER
    // is not consulted: nothing in the payment path reads it any more.
    skip: () => {
      if (env.payments.onlineEnabled) return null;
      const key = providerRegistry.credentialsKeyState(env.payments.credentialsKey);
      // A malformed key is worth a warning even while payments are off.
      if (key === 'invalid') return null;
      return (
        `PAYMENTS_ONLINE_ENABLED is off — stores take cash on delivery only. ` +
        `Registered gateways: ${gatewayNames()}. GATEWAY_CREDENTIALS_KEY ${key === 'present' ? 'is present, so merchants can already connect an account' : 'is not set, so merchants cannot connect an account yet'}.`
      );
    },
    run: probePaymentGateways,
  },
];

function gatewayNames() {
  // A gateway switched off for every store (Fawaterak's own flag) is not named.
  const names = gateways.listOfferedAdapters().map((a) => a.name);
  return names.length > 0 ? names.join(', ') : 'none';
}

/**
 * The online payment state as it really is: the flag, the credentials key,
 * and — only when both allow online payments — whether each registered
 * gateway's API host answers. That probe is the registry's own (one
 * unauthenticated GET per gateway, no merchant's keys), so it proves the host
 * is reachable from this server and nothing about any account.
 */
async function probePaymentGateways() {
  const key = providerRegistry.credentialsKeyState(env.payments.credentialsKey);
  if (!env.payments.onlineEnabled) {
    return {
      status: 'degraded',
      detail:
        'PAYMENTS_ONLINE_ENABLED is off, and GATEWAY_CREDENTIALS_KEY is set but is not 32 bytes of base64 — fix it before turning online payments on.',
    };
  }
  if (key !== 'present') {
    return {
      status: 'down',
      detail: `PAYMENTS_ONLINE_ENABLED is on, but GATEWAY_CREDENTIALS_KEY is ${key === 'missing' ? 'not set' : 'not 32 bytes of base64'} — online checkout and every gateway feature answer 503.`,
    };
  }

  const adapters = gateways.listOfferedAdapters();
  if (adapters.length === 0) {
    return { status: 'down', detail: 'PAYMENTS_ONLINE_ENABLED is on, but no payment gateway is registered.' };
  }
  const checks = await Promise.all(adapters.map((a) => providerRegistry.checkGateway(a.code)));
  const reached = checks.filter((c) => c.status === 'operational' || c.status === 'degraded');
  const readings = adapters
    .map((a, i) => {
      const c = checks[i];
      if (c.status === 'not_checkable') return `${a.name}: not checkable`;
      if (c.httpStatus === null) return `${a.name}: ${c.target} did not answer`;
      return `${a.name}: ${c.target} HTTP ${c.httpStatus} (${c.latencyMs} ms)`;
    })
    .join('; ');
  const detail = `Online payments on, credentials key present. ${readings}. Reachability only — no merchant account was used.`;

  if (reached.length === 0) return { status: checks.some((c) => c.status === 'down') ? 'down' : 'degraded', detail };
  if (reached.length < adapters.length || checks.some((c) => c.status === 'degraded')) return { status: 'degraded', detail };
  return { detail };
}

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
