'use strict';

const { QueryTypes } = require('sequelize');
const env = require('../../config/env');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const carriers = require('../shipping/carriers');
const gateways = require('../payments/gateways');

/**
 * The platform admin's read-only view of the courier and payment gateway
 * adapters registered in this backend: what each one is, whether this server
 * offers it, and how many merchants have connected it.
 *
 * Read-only by design. Which adapters exist on a server is decided by the
 * environment and nothing else — CARRIERS_ENABLED / CARRIERS_BETA /
 * CARRIERS_BETA_WORKSPACES for couriers, PAYMENTS_ONLINE_ENABLED and
 * GATEWAY_CREDENTIALS_KEY for gateways, plus a gateway's own switch where it
 * has one (PAYMENTS_FAWATERAK_*) — so there is no switch here, and
 * nothing in this file is read by the code that decides availability.
 *
 * The health check is a reachability probe that uses NO merchant's
 * credentials: one unauthenticated GET to the provider's API host. Any HTTP
 * answer (a 401 or 404 included) proves the host is up and reachable from
 * this server; it says nothing about any merchant's account. A provider
 * whose API host is not known here answers `not_checkable`.
 */

const PROBE_TIMEOUT_MS = 5000;
// A probe that answers but takes longer than this reads as degraded.
const SLOW_MS = 2000;

/**
 * 'present' | 'missing' | 'invalid' for an AES-256 key read from the env
 * (32 bytes of base64 — see core/utils/credentialsCipher). Never the key.
 */
function credentialsKeyState(raw) {
  if (!raw) return 'missing';
  return Buffer.from(raw, 'base64').length === 32 ? 'present' : 'invalid';
}

// ---------------------------------------------------------------- probe targets

/** Where a courier adapter's API lives, from the adapter itself. */
function carrierProbeUrl(adapter) {
  if (typeof adapter.BASE_URL === 'string') return adapter.BASE_URL;
  if (adapter.BASE_URLS && typeof adapter.BASE_URLS.production === 'string') return adapter.BASE_URLS.production;
  return null;
}

/** Where a gateway's live API lives — Paymob's and Kashier's are configurable per server. */
const GATEWAY_PROBE_URLS = {
  paymob: () => env.payments.paymobBaseUrl,
  kashier: () => env.payments.kashier.liveApiUrl,
  fawaterak: () => require('../billing/fawaterak/config').BASE_URLS.live,
};

function gatewayProbeUrl(adapter) {
  const target = GATEWAY_PROBE_URLS[adapter.code];
  return target ? target() : null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return null;
  }
}

/**
 * One unauthenticated GET, bounded by PROBE_TIMEOUT_MS. Never throws: every
 * outcome is a reading. No header carries anything of ours but a User-Agent.
 */
async function probe(url) {
  const checkedAt = new Date().toISOString();
  if (!url) {
    return {
      status: 'not_checkable',
      httpStatus: null,
      latencyMs: null,
      target: null,
      detail: 'No API host is known for this provider, so it cannot be checked without a merchant’s credentials.',
      checkedAt,
    };
  }

  const target = hostOf(url);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'zimos-admin-health-check' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // The body is not read — only that something answered.
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
    const latencyMs = Date.now() - startedAt;
    if (res.status >= 500) {
      return {
        status: 'degraded',
        httpStatus: res.status,
        latencyMs,
        target,
        detail: `${target} answered HTTP ${res.status}.`,
        checkedAt,
      };
    }
    return {
      status: latencyMs > SLOW_MS ? 'degraded' : 'operational',
      httpStatus: res.status,
      latencyMs,
      target,
      detail:
        `${target} answered HTTP ${res.status}` +
        (latencyMs > SLOW_MS ? `, slowly (${latencyMs} ms).` : '.') +
        ' Reachability only — no merchant account was used.',
      checkedAt,
    };
  } catch (err) {
    return {
      status: 'down',
      httpStatus: null,
      latencyMs: Date.now() - startedAt,
      target,
      detail: `${target} did not answer: ${err.name === 'TimeoutError' ? `no response within ${PROBE_TIMEOUT_MS} ms` : 'could not connect'}.`,
      checkedAt,
    };
  }
}

// ----------------------------------------------------------------- connections

/** { code -> { workspaces, active, invalid, live, test } } for one accounts table. */
async function connectionCounts(table, codeColumn, { withMode = false } = {}) {
  const rows = await db.sequelize.query(
    `SELECT ${codeColumn} AS code,
            count(DISTINCT workspace_id)::int AS workspaces,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'invalid')::int AS invalid
            ${withMode ? ", count(*) FILTER (WHERE mode = 'live')::int AS live, count(*) FILTER (WHERE mode = 'test')::int AS test" : ''}
       FROM ${table}
      GROUP BY ${codeColumn}`,
    { type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.code, r]));
}

function connectionsOf(counts, code, withMode) {
  const row = counts.get(code);
  return {
    workspaces: row ? row.workspaces : 0,
    active: row ? row.active : 0,
    invalid: row ? row.invalid : 0,
    ...(withMode ? { live: row ? row.live : 0, test: row ? row.test : 0 } : {}),
  };
}

// -------------------------------------------------------------------- carriers

function rolloutDetail(state) {
  if (state === 'enabled') return 'Listed in CARRIERS_ENABLED — every store can connect it.';
  if (state === 'beta') {
    const slugs = env.carriers.betaWorkspaces;
    return slugs.length > 0
      ? `Listed in CARRIERS_BETA — only these stores see it: ${slugs.join(', ')}.`
      : 'Listed in CARRIERS_BETA, but CARRIERS_BETA_WORKSPACES is empty, so no store sees it.';
  }
  return 'Registered in the code, but in neither CARRIERS_ENABLED nor CARRIERS_BETA — no store sees it on this server.';
}

function describeCarrier(adapter, state, counts) {
  const probeUrl = carrierProbeUrl(adapter);
  return {
    code: adapter.code,
    name: adapter.name,
    registered: true,
    rollout: state || 'off',
    rolloutDetail: rolloutDetail(state),
    capabilities: {
      ...adapter.capabilities,
      addressLevels: [...adapter.capabilities.addressLevels],
      sandbox: typeof adapter.isSandbox === 'function',
    },
    connections: connectionsOf(counts, adapter.code, false),
    healthCheck: { checkable: Boolean(probeUrl), target: probeUrl ? hostOf(probeUrl) : null },
  };
}

/**
 * Accounts can outlive their adapter (a carrier removed from the code). Those
 * codes are listed too, so their connections are not silently uncounted.
 */
function orphanRows(counts, knownCodes, withMode, extra) {
  return [...counts.keys()]
    .filter((code) => !knownCodes.has(code))
    .sort()
    .map((code) => ({
      code,
      name: code,
      registered: false,
      ...extra,
      connections: connectionsOf(counts, code, withMode),
      healthCheck: { checkable: false, target: null },
    }));
}

async function listCarriers() {
  const counts = await connectionCounts('carrier_accounts', 'carrier_code');
  const registered = carriers.listRegistered();
  const rows = registered.map(({ adapter, rollout }) => describeCarrier(adapter, rollout, counts));
  const orphans = orphanRows(counts, new Set(registered.map((r) => r.adapter.code)), false, {
    rollout: 'off',
    rolloutDetail: 'No adapter with this code is registered any more; these accounts cannot be used.',
    capabilities: null,
  });
  const { enabled, beta, betaWorkspaces, warnings } = carriers.describeRollout();
  return {
    carriers: [...rows, ...orphans],
    environment: {
      enabled,
      beta,
      betaWorkspaces,
      warnings,
      credentialsKey: credentialsKeyState(env.carriers.credentialsKey),
    },
  };
}

async function checkCarrier(code) {
  const entry = carriers.listRegistered().find(({ adapter }) => adapter.code === code);
  if (!entry) throw new NotFoundError('Carrier');
  return { code, ...(await probe(carrierProbeUrl(entry.adapter))) };
}

// -------------------------------------------------------------------- gateways

/**
 * The server as a whole: what every gateway without a switch of its own
 * shares (gatewayAvailabilityFor narrows it for one that has one).
 */
function gatewayAvailability() {
  const key = credentialsKeyState(env.payments.credentialsKey);
  if (key !== 'present') {
    return {
      availability: 'off',
      availabilityDetail:
        key === 'missing'
          ? 'GATEWAY_CREDENTIALS_KEY is not set — every gateway feature answers 503 on this server.'
          : 'GATEWAY_CREDENTIALS_KEY is set but is not 32 bytes of base64 — every gateway feature answers 503.',
    };
  }
  if (!env.payments.onlineEnabled) {
    return {
      availability: 'connect_only',
      availabilityDetail:
        'PAYMENTS_ONLINE_ENABLED is off — merchants can connect an account, but shoppers are only offered cash on delivery.',
    };
  }
  return {
    availability: 'enabled',
    availabilityDetail: 'PAYMENTS_ONLINE_ENABLED is on — stores with a connected account take online payments.',
  };
}

/** The server's availability for one gateway, narrowed by its own switch (Fawaterak). */
function gatewayAvailabilityFor(adapter, base) {
  const rollout = gateways.describeRollout(adapter.code);
  if (!rollout || base.availability === 'off') return base;
  if (rollout.state === 'off') {
    return {
      availability: 'off',
      availabilityDetail: `${rollout.enabledVar} is off — no store sees ${adapter.name}; payments already started through it are still settled.`,
    };
  }
  if (rollout.state === 'beta') {
    return {
      ...base,
      availabilityDetail: `${base.availabilityDetail} Only the stores in ${rollout.betaVar} see ${adapter.name}: ${rollout.betaWorkspaces.join(', ')}.`,
    };
  }
  return base;
}

function describeGateway(adapter, counts, availability) {
  const probeUrl = gatewayProbeUrl(adapter);
  return {
    code: adapter.code,
    name: adapter.name,
    registered: true,
    ...availability,
    capabilities: {
      methods: [...adapter.methods],
      currencies: [...adapter.currencies],
      // Refunds sent from here; a gateway refunded in its own dashboard sends none (Fawaterak).
      refunds: typeof adapter.refund === 'function' && !adapter.refundsInGatewayDashboard,
      statusInquiry: typeof adapter.inquire === 'function',
      webhook: adapter.webhookSetup ? { automatic: Boolean(adapter.webhookSetup.automatic) } : null,
      methodsFromAccount: adapter.settingFields.length === 0,
    },
    connections: connectionsOf(counts, adapter.code, true),
    healthCheck: { checkable: Boolean(probeUrl), target: probeUrl ? hostOf(probeUrl) : null },
  };
}

async function listGateways() {
  const counts = await connectionCounts('payment_gateway_accounts', 'provider_code', { withMode: true });
  const availability = gatewayAvailability();
  const adapters = gateways.listAdapters();
  const rows = adapters.map((adapter) => describeGateway(adapter, counts, gatewayAvailabilityFor(adapter, availability)));
  const orphans = orphanRows(counts, new Set(adapters.map((a) => a.code)), true, {
    availability: 'off',
    availabilityDetail: 'No gateway with this code is registered any more; these accounts cannot be used.',
    capabilities: null,
  });
  return {
    gateways: [...rows, ...orphans],
    environment: {
      onlineEnabled: env.payments.onlineEnabled,
      credentialsKey: credentialsKeyState(env.payments.credentialsKey),
    },
  };
}

async function checkGateway(code) {
  const adapter = gateways.getAdapter(code);
  if (!adapter) throw new NotFoundError('Payment gateway');
  return { code, ...(await probe(gatewayProbeUrl(adapter))) };
}

module.exports = {
  listCarriers,
  checkCarrier,
  listGateways,
  checkGateway,
  gatewayAvailability,
  credentialsKeyState,
  PROBE_TIMEOUT_MS,
};
