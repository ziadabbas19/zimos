'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const cipher = require('../../core/utils/credentialsCipher');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const { getAdapter, listAdapters } = require('./carriers');
const { CarrierAuthError } = require('./carriers/carrierErrors');
const { buildIndex } = require('./carrierAddressMatching');

/**
 * A merchant's connected courier accounts: connect (verify first, store only
 * on success), disconnect, and the decrypted credentials every carrier call
 * needs.
 *
 * Credentials are write-only. They are decrypted here, handed to the adapter
 * and dropped; no response, log line or audit row ever carries them — audits
 * say `credentialsUpdated: true` and nothing more.
 */

// Encryption context: a stored credential only decrypts on the row it was
// written for (see credentialsCipher).
const aadFor = (workspaceId, carrierCode) => `${workspaceId}:${carrierCode}`;

function assertConfigured() {
  if (!cipher.isConfigured()) {
    logger.error('Carrier request refused: CARRIER_CREDENTIALS_KEY is not configured');
    throw new AppError(
      'CARRIERS_NOT_CONFIGURED',
      'Courier integrations are not available on this server yet. Please contact support.',
      503
    );
  }
}

function requireAdapter(code) {
  const adapter = getAdapter(code);
  if (!adapter) throw new NotFoundError('Carrier');
  return adapter;
}

function webhookUrlFor(account) {
  return `${env.appUrl.replace(/\/+$/, '')}/api/${env.apiVersion}/webhooks/carriers/${account.carrierCode}/${account.webhookToken}`;
}

/** 32 random bytes, base64url: 43 URL-safe characters. */
function newWebhookToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function describeConnection(account) {
  if (!account) return null;
  return {
    status: account.status,
    settings: account.settings || {},
    lastVerifiedAt: account.lastVerifiedAt,
    connectedAt: account.createdAt,
    updatedAt: account.updatedAt,
    webhookUrl: webhookUrlFor(account),
  };
}

function describeAdapter(adapter) {
  return {
    code: adapter.code,
    name: adapter.name,
    webhookSetup: adapter.webhookSetup,
    supportsLabel: Boolean(adapter.supportsLabel),
    credentialFields: adapter.credentialFields,
    settingFields: adapter.settingFields,
  };
}

async function listCarriers(workspaceId) {
  const accounts = await db.CarrierAccount.findAll({ where: { workspaceId } });
  const byCode = new Map(accounts.map((a) => [a.carrierCode, a]));
  return {
    configured: cipher.isConfigured(),
    carriers: listAdapters().map((adapter) => ({
      ...describeAdapter(adapter),
      connection: describeConnection(byCode.get(adapter.code)),
    })),
  };
}

function validatePart(schema, value, prefix) {
  const { error, value: clean } = schema.validate(value, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new ValidationError(
      error.details.map((d) => ({ field: [prefix, ...d.path].join('.'), message: d.message })),
      'Invalid body'
    );
  }
  return clean;
}

/**
 * Marks an account invalid when the carrier rejects its credentials — on its
 * own connection, so it sticks even though the caller's transaction is about
 * to roll back with the error.
 */
async function withAuthHandling(account, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CarrierAuthError && account && account.id) {
      await db.CarrierAccount.update({ status: 'invalid' }, { where: { id: account.id } }).catch((updateErr) =>
        logger.error('Could not mark carrier account invalid', { accountId: account.id, message: updateErr.message })
      );
      logger.warn('Carrier rejected stored credentials; account marked invalid', {
        workspaceId: account.workspaceId,
        carrierCode: account.carrierCode,
      });
    }
    throw err;
  }
}

/**
 * A tierMap keeps only this store's current tiers. Deleting a tier leaves
 * its id behind in the saved map; dropping it here (rather than refusing the
 * whole save) keeps every later settings save working.
 */
async function ownTiersOnly(workspaceId, tierMap) {
  const ids = Object.keys(tierMap);
  if (ids.length === 0) return tierMap;
  const own = new Set(
    (await db.ShippingWeightTier.findAll({ where: { workspaceId, id: ids }, attributes: ['id'] })).map((t) => t.id)
  );
  return Object.fromEntries(Object.entries(tierMap).filter(([id]) => own.has(id)));
}

/**
 * PUT /carriers/:code. Verifies with the carrier before anything is written;
 * a rejected key stores nothing. `credentials` may be omitted to change only
 * the settings of an existing connection (the stored ones are re-verified).
 */
async function connect(workspaceId, code, body, req) {
  const adapter = requireAdapter(code);
  assertConfigured();

  const existing = await db.CarrierAccount.scope('withCredentials').findOne({ where: { workspaceId, carrierCode: code } });
  if (!body.credentials && !existing) {
    throw new ValidationError([{ field: 'credentials', message: '"credentials" is required' }], 'Invalid body');
  }

  const settings = validatePart(adapter.settingsSchema, body.settings || (existing ? existing.settings : {}), 'settings');
  if (settings.tierMap) settings.tierMap = await ownTiersOnly(workspaceId, settings.tierMap);
  let credentials;
  if (body.credentials) {
    credentials = validatePart(adapter.credentialsSchema, body.credentials, 'credentials');
  } else {
    credentials = decryptFor(existing);
  }

  // A rejected key here is the merchant typing it wrong: 422, nothing stored.
  // If it is the STORED key that was rejected, the account is marked invalid.
  const verification = await withAuthHandling(body.credentials ? null : existing, () =>
    adapter.verifyCredentials(credentials, settings)
  );

  const values = {
    credentialsEncrypted: cipher.encrypt(credentials, aadFor(workspaceId, code)),
    settings,
    status: 'active',
    lastVerifiedAt: new Date(),
  };

  const account = await db.sequelize.transaction(async (transaction) => {
    let row;
    let action;
    let before = null;
    if (existing) {
      before = { status: existing.status, settings: existing.settings };
      await existing.update(values, { transaction });
      row = existing;
      action = 'carrier_account.update';
    } else {
      row = await db.CarrierAccount.create(
        { workspaceId, carrierCode: code, webhookToken: newWebhookToken(), ...values },
        { transaction }
      );
      action = 'carrier_account.connect';
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action,
      entityType: 'CarrierAccount',
      entityId: row.id,
      before,
      after: { carrierCode: code, status: 'active', settings, credentialsUpdated: Boolean(body.credentials) },
      req,
      transaction,
    });
    return row;
  });

  clearCitiesCache(workspaceId, code);
  return {
    carrier: { ...describeAdapter(adapter), connection: describeConnection(account) },
    webhook: {
      url: webhookUrlFor(account),
      // Bosta takes the URL on every delivery we create, so there is nothing
      // to paste into its dashboard.
      setup: adapter.webhookSetup,
      manualSetupRequired: adapter.webhookSetup === 'account',
    },
    verification,
  };
}

/** DELETE /carriers/:code. Shipments keep their data; syncing them stops. */
async function disconnect(workspaceId, code, req) {
  requireAdapter(code);
  return db.sequelize.transaction(async (transaction) => {
    const account = await db.CarrierAccount.findOne({ where: { workspaceId, carrierCode: code }, transaction });
    if (!account) throw new NotFoundError('Carrier connection');
    await account.destroy({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'carrier_account.disconnect',
      entityType: 'CarrierAccount',
      entityId: account.id,
      before: { carrierCode: code, status: account.status, settings: account.settings },
      req,
      transaction,
    });
    clearCitiesCache(workspaceId, code);
    return { disconnected: true };
  });
}

function decryptFor(account) {
  assertConfigured();
  try {
    return cipher.decrypt(account.credentialsEncrypted, aadFor(account.workspaceId, account.carrierCode));
  } catch (err) {
    // Wrong/rotated key or a tampered row. The message never includes the value.
    logger.error('Could not decrypt carrier credentials', {
      workspaceId: account.workspaceId,
      carrierCode: account.carrierCode,
      reason: err.message,
    });
    throw new AppError(
      'CARRIER_CREDENTIALS_UNREADABLE',
      'The stored courier credentials could not be read. Reconnect the courier account.',
      409
    );
  }
}

/**
 * The adapter, account and decrypted credentials for a connected carrier.
 * 503 when the server has no key; 409 CARRIER_NOT_CONNECTED otherwise.
 */
async function loadConnection(workspaceId, code, { transaction } = {}) {
  const adapter = requireAdapter(code);
  assertConfigured();
  const account = await db.CarrierAccount.scope('withCredentials').findOne({
    where: { workspaceId, carrierCode: code },
    transaction,
  });
  if (!account) {
    throw new AppError(
      'CARRIER_NOT_CONNECTED',
      `${adapter.name} is not connected for this store. Connect it under shipping settings, or use carrierCode "manual".`,
      409
    );
  }
  return { adapter, account, credentials: decryptFor(account) };
}

// --- cities (in-memory, per workspace + carrier, ~1h) ----------------------

const CITIES_TTL_MS = 60 * 60 * 1000;
const citiesCache = new Map();

function clearCitiesCache(workspaceId, code) {
  if (workspaceId === undefined) citiesCache.clear();
  else citiesCache.delete(`${workspaceId}:${code}`);
}

/** { cities, index } — the carrier list and its normalised match index. */
async function loadCities(connection) {
  const key = `${connection.account.workspaceId}:${connection.adapter.code}`;
  const hit = citiesCache.get(key);
  if (hit && Date.now() - hit.at < CITIES_TTL_MS) return hit.value;

  const cities = await withAuthHandling(connection.account, () => connection.adapter.listCities(connection.credentials));
  const value = { cities, index: await buildIndex(cities) };
  citiesCache.set(key, { at: Date.now(), value });
  return value;
}

async function getCities(workspaceId, code, { cityId } = {}) {
  const connection = await loadConnection(workspaceId, code);
  const { cities } = await loadCities(connection);
  if (cityId) {
    const city = cities.find((c) => c.id === cityId);
    if (!city) throw new NotFoundError('City');
    return { cities: [city] };
  }
  return { cities };
}

module.exports = {
  listCarriers,
  connect,
  disconnect,
  loadConnection,
  loadCities,
  getCities,
  withAuthHandling,
  webhookUrlFor,
  clearCitiesCache,
  decryptFor,
  aadFor,
};
