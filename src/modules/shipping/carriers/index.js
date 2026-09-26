'use strict';

const db = require('../../../db/models');
const env = require('../../../config/env');
const bosta = require('./bosta');
const mylerz = require('./mylerz');
const jtexpress = require('./jtexpress');
const { defineAdapter } = require('./adapterContract');
const { AppError, ValidationError } = require('../../../core/errors/AppError');

/**
 * Courier adapters: one file per carrier, built with defineAdapter() (see
 * ./adapterContract for the capabilities) and registered below. Adding a
 * carrier is a new file + one line in REGISTERED; the routes, services,
 * webhook, poller and tests are carrier-agnostic.
 *
 * Which registered adapters exist on a server is env-driven (env.carriers):
 *   CARRIERS_ENABLED           every store sees them (default: bosta)
 *   CARRIERS_BETA              only stores listed in CARRIERS_BETA_WORKSPACES
 * An adapter in neither list — or a beta one, for any other store — does not
 * exist: not listed, not connectable, its name free for manual shipments.
 *
 * 'manual' is not an adapter and never will be: it is a shipment the merchant
 * books themselves and types the waybill number into. Any carrierCode without
 * an adapter keeps that manual behaviour.
 *
 * ---------------------------------------------------------------------------
 * Adapter interface
 * ---------------------------------------------------------------------------
 * Descriptive fields
 *   code, name, nameAliases
 *   capabilities          see ./adapterContract
 *   credentialFields      [{ key, label, secret }] — for the connect form
 *   settingFields         [{ key, label, options? }]
 *   credentialsSchema     Joi schema for the credentials object
 *   settingsSchema        Joi schema for carrier-specific settings
 *   webhookSetup, supportsLabel   derived from capabilities
 *
 * Every function receives the DECRYPTED credentials first. Never log them.
 * Errors: throw CarrierAuthError (credentials rejected -> 422, account marked
 * invalid), CarrierPermissionError (key lacks the scope -> 422) or
 * CarrierError (anything else -> 502) from ./carrierErrors; messages must be
 * sanitised (sanitizeCarrierMessage). All HTTP goes through
 * ./carrierHttp.request — creates without retry, reads with retry.
 *
 *   verifyCredentials(creds, settings) -> { pickupLocations?: [...] }
 *   resolvePackage(settings, tier) -> package description (optional)
 *       The package to book for a weight tier ({ id, ... } or null), from
 *       the account settings. Throws 422 CARRIER_TIER_UNMAPPED when the
 *       settings map tiers but not this one. Passed back as `package`.
 *   listCities(creds)  (city/district carriers)
 *       -> [{ id, name, nameAr, dropOffAvailable,
 *             districts: [{ id, name, nameAr, zoneId, zoneName,
 *                           zoneNameAr, dropOffAvailable }] }]
 *   listAddressTree(creds)  (any number of levels)
 *       -> [{ id, name, nameAr, dropOffAvailable?, aliases?: [name...],
 *             meta?: {...}, children?: [same shape] }]
 *       Depth = capabilities.addressLevels.length; leaves are bookable.
 *   createShipment(creds, { order, address, cod, goodsValue, itemsCount,
 *                           description, notes, carrierSettings, package,
 *                           webhookUrl })
 *       -> { trackingNumber, carrierShipmentId, trackingUrl?, labelUrl?, raw }
 *       `address` = { path: [{ id, name, nameAr, level, meta }], firstLine,
 *       secondLine } plus, for city/district carriers, cityId, cityName,
 *       districtId, zoneId. `cod` and `goodsValue` are in OUR minor units;
 *       the adapter converts. `raw` is what gets stored on the shipment:
 *       whitelist, no PII/secrets.
 *   getShipment(creds, trackingNumber)
 *       -> { status, carrierStatus, raw }
 *       `status` is OUR Shipment status, or null when the carrier state says
 *       nothing we can act on (unknown states are logged by the adapter).
 *   getShipments(creds, trackingNumbers)  (bulkStatus)
 *       -> Map(trackingNumber -> getShipment-shaped result); a number the
 *       carrier did not answer for is simply absent
 *   cancelShipment(creds, trackingNumber, { carrierShipmentId }) -> resolves,
 *       or throws if refused (cancel 'api' only). carrierShipmentId is what
 *       createShipment returned, for a carrier that cancels by its own id
 *       rather than the tracking number.
 *   isCancelSettled(carrierStatus) -> boolean (optional)
 *   getLabel(creds, trackingNumber, settings) -> PDF Buffer (label)
 *   parseWebhook(req) -> { ref, status?, carrierStatus? } | null
 *       `ref` is the tracking number. The status is used only when
 *       capabilities.webhookRefetch is false and verifyWebhook passed.
 *   verifyWebhook(req, { account, credentials }) -> boolean (optional)
 *   isSandbox(creds) -> boolean (optional)
 *       The credentials point at the carrier's test environment, which ships
 *       nothing. Only stores in CARRIERS_BETA_WORKSPACES may connect such an
 *       account or book with it (assertSandboxAllowed).
 */
// Registering an adapter does not switch it on: only CARRIERS_ENABLED /
// CARRIERS_BETA make it exist on a server (rollout below). Every carrier
// after Bosta ships as beta first.
const REGISTERED = new Map([bosta, mylerz, jtexpress].map((adapter) => [adapter.code, adapter]));

const MANUAL = 'manual';

/** 'enabled' | 'beta' | null for a registered adapter code. */
function rollout(code) {
  if (!code || !REGISTERED.has(code)) return null;
  if (env.carriers.enabled.includes(code)) return 'enabled';
  if (env.carriers.beta.includes(code)) return 'beta';
  return null;
}

/**
 * The adapter for a code on this server (enabled or beta), or null. Beta
 * adapters still need a per-store check: availableFor / adapterFor.
 */
function getAdapter(code) {
  if (!code || code === MANUAL) return null;
  return rollout(code) ? REGISTERED.get(code) : null;
}

function listAdapters() {
  return [...REGISTERED.values()].filter((adapter) => rollout(adapter.code));
}

/** The store's slug (null when there is no such store) and whether it is in the beta. */
async function betaMembership(workspaceId) {
  const workspace = workspaceId ? await db.Workspace.findByPk(workspaceId, { attributes: ['slug'] }) : null;
  const slug = workspace ? String(workspace.slug).toLowerCase() : null;
  return { slug, inBeta: Boolean(slug && env.carriers.betaWorkspaces.includes(slug)) };
}

async function workspaceInBeta(workspaceId) {
  if (!workspaceId || env.carriers.betaWorkspaces.length === 0) return false;
  return (await betaMembership(workspaceId)).inBeta;
}

/**
 * 422 on connect / 409 on booking when the credentials point at the carrier's
 * sandbox and the store is not a test store: a real store must never book
 * real orders into a test system that ships nothing.
 */
async function assertSandboxAllowed(adapter, credentials, workspaceId, { booking = false } = {}) {
  if (typeof adapter.isSandbox !== 'function' || !adapter.isSandbox(credentials)) return;
  if (await workspaceInBeta(workspaceId)) return;
  const message = `The ${adapter.name} sandbox only creates test shipments, and it is available to test stores only. Connect a production ${adapter.name} account.`;
  if (booking) {
    throw new AppError('CARRIER_SANDBOX_NOT_ALLOWED', `${message} Nothing was booked.`, 409, { carrierCode: adapter.code });
  }
  throw new ValidationError([{ field: 'credentials.environment', message }]);
}

/** Whether this store may see and use the adapter. */
async function availableFor(adapter, workspaceId) {
  const state = adapter ? rollout(adapter.code) : null;
  if (state === 'enabled') return true;
  if (state === 'beta') return workspaceInBeta(workspaceId);
  return false;
}

/** The adapter for a code as this store sees it, or null. */
async function adapterFor(code, workspaceId) {
  const adapter = getAdapter(code);
  return adapter && (await availableFor(adapter, workspaceId)) ? adapter : null;
}

/**
 * Every adapter this store may see, in registration order, plus the slug it
 * was decided on — GET /carriers logs both. The slug is always looked up,
 * even when no beta adapter is on, so that log line says which store asked.
 */
async function resolveAdaptersFor(workspaceId) {
  const { slug, inBeta } = await betaMembership(workspaceId);
  const adapters = listAdapters().filter((adapter) => rollout(adapter.code) === 'enabled' || inBeta);
  return { adapters, slug, inBeta };
}

/** Every adapter this store may see, in registration order. */
async function adaptersFor(workspaceId) {
  return (await resolveAdaptersFor(workspaceId)).adapters;
}

// A carrier code or slug is lower-case letters, digits, '-' and '_'. Quotes
// are called out on their own: a dashboard env editor keeps quotes typed
// around a value, and '"mylerz' is then silently not a carrier.
const QUOTES = /["'`‘’“”]/;
const PLAIN_ENTRY = /^[a-z0-9_-]+$/;

/**
 * The rollout as this process parsed it, and what in it looks wrong — for
 * the boot log. Codes and slugs only; nothing secret. `existingSlugs`
 * (lower-cased), when given, checks CARRIERS_BETA_WORKSPACES against the
 * stores that exist.
 */
function describeRollout({ existingSlugs } = {}) {
  const { enabled, beta, betaWorkspaces } = env.carriers;
  const registered = [...REGISTERED.keys()];
  const warnings = [];
  const lists = [
    ['CARRIERS_ENABLED', enabled, true],
    ['CARRIERS_BETA', beta, true],
    ['CARRIERS_BETA_WORKSPACES', betaWorkspaces, false],
  ];
  for (const [name, list, isCodes] of lists) {
    for (const value of list) {
      if (QUOTES.test(value)) {
        warnings.push(`${name} entry ${JSON.stringify(value)} contains a quote character; set the variable without quotes`);
      } else if (!PLAIN_ENTRY.test(value)) {
        warnings.push(`${name} entry ${JSON.stringify(value)} contains unexpected characters`);
      } else if (isCodes && !REGISTERED.has(value)) {
        warnings.push(`${name} entry ${JSON.stringify(value)} is not a registered carrier (registered: ${registered.join(', ')})`);
      }
    }
  }
  if (beta.length > 0 && betaWorkspaces.length === 0) {
    warnings.push('CARRIERS_BETA is set but CARRIERS_BETA_WORKSPACES is empty: no store sees the beta carriers');
  }
  if (existingSlugs) {
    const known = new Set(existingSlugs);
    for (const slug of betaWorkspaces) {
      if (!QUOTES.test(slug) && !known.has(slug)) {
        warnings.push(`CARRIERS_BETA_WORKSPACES entry ${JSON.stringify(slug)} matches no workspace slug`);
      }
    }
  }
  return {
    enabled,
    beta,
    betaWorkspaces,
    registered,
    active: listAdapters().map((adapter) => adapter.code),
    warnings,
  };
}

/**
 * Logs the parsed rollout once at boot (server.js), one warning per problem.
 * A failed workspace lookup only skips the slug check.
 */
async function logRollout(logger) {
  let existingSlugs;
  const slugs = env.carriers.betaWorkspaces;
  if (slugs.length > 0) {
    try {
      const rows = await db.Workspace.findAll({
        attributes: ['slug'],
        where: db.Sequelize.where(db.Sequelize.fn('lower', db.Sequelize.col('slug')), { [db.Sequelize.Op.in]: slugs }),
      });
      existingSlugs = rows.map((row) => String(row.slug).toLowerCase());
    } catch (err) {
      logger.warn('Carrier rollout: could not check CARRIERS_BETA_WORKSPACES against the workspaces', { message: err.message });
    }
  }
  const { warnings, ...config } = describeRollout({ existingSlugs });
  logger.info('Carrier rollout', config);
  for (const warning of warnings) logger.warn(`Carrier rollout: ${warning}`);
  return { ...config, warnings };
}

/**
 * A courier name reduced to what distinguishes it: case, spacing and
 * separators dropped; for Arabic, tatweel and diacritics dropped and ة read
 * as ه ("بوسـطَة" -> "بوسطه").
 */
function foldCourierName(name) {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ً-ٰٟۖ-ۭـ]/g, '')
    .replace(/ة/g, 'ه')
    .replace(/[\s\-_.]+/g, '');
}

/**
 * The adapter a free-text courier name spells ("Bosta", " BOSTA ", "bo-sta",
 * "بوسطة" -> bosta), or null — among the adapters on this server. Whether the
 * name is actually refused depends on the store (see
 * carrierShipmentService.shouldBookWithCarrier).
 */
function reservedAdapterFor(name) {
  if (typeof name !== 'string') return null;
  const folded = foldCourierName(name);
  for (const adapter of listAdapters()) {
    if ([adapter.code, ...adapter.nameAliases].some((n) => foldCourierName(n) === folded)) return adapter;
  }
  return null;
}

/**
 * Registers an adapter for the current test file only (tests/helpers/
 * fakeCarriers.js). Returns the function that removes it again.
 */
function registerTestAdapter(spec) {
  if (!env.isTest) throw new Error('registerTestAdapter is only available under NODE_ENV=test');
  const adapter = spec.capabilities && Object.isFrozen(spec.capabilities) ? spec : defineAdapter(spec);
  REGISTERED.set(adapter.code, adapter);
  return () => {
    if (REGISTERED.get(adapter.code) === adapter) REGISTERED.delete(adapter.code);
  };
}

module.exports = {
  getAdapter,
  listAdapters,
  adapterFor,
  adaptersFor,
  resolveAdaptersFor,
  describeRollout,
  logRollout,
  availableFor,
  assertSandboxAllowed,
  reservedAdapterFor,
  registerTestAdapter,
  MANUAL,
};
