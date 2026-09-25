'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const cipher = require('../../core/utils/credentialsCipher');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const gateways = require('./gateways');
const { GatewayAuthError } = require('./gateways/gatewayErrors');

/**
 * A merchant's connected payment gateway accounts: connect (verify first,
 * store only on success), disconnect, and the decrypted credentials every
 * gateway call needs.
 *
 * Credentials are write-only. They are decrypted here, handed to the adapter
 * and dropped; no response, log line or audit row ever carries them — audits
 * say `credentialsUpdated: true` and nothing more. Encrypted with
 * GATEWAY_CREDENTIALS_KEY, bound to `<workspaceId>:<providerCode>`.
 */

const aadFor = (workspaceId, providerCode) => `${workspaceId}:${providerCode}`;

/** Read on every call so tests can swap it. */
const credentialsKey = () => cipher.parseKey(env.payments.credentialsKey, 'GATEWAY_CREDENTIALS_KEY');

function isConfigured() {
  return credentialsKey() !== null;
}

function assertConfigured() {
  if (!isConfigured()) {
    logger.error('Gateway request refused: GATEWAY_CREDENTIALS_KEY is not configured');
    throw new AppError(
      'GATEWAYS_NOT_CONFIGURED',
      'Online payments are not available on this server yet. Please contact support.',
      503
    );
  }
}

function requireAdapter(code) {
  const adapter = gateways.getAdapter(code);
  if (!adapter) throw new NotFoundError('Payment gateway');
  return adapter;
}

function webhookUrlFor(account) {
  return `${env.appUrl.replace(/\/+$/, '')}/api/${env.apiVersion}/webhooks/payments/${account.providerCode}/${account.webhookToken}`;
}

function newWebhookToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function describeConnection(account) {
  if (!account) return null;
  const adapter = gateways.getAdapter(account.providerCode);
  return {
    status: account.status,
    mode: account.mode,
    settings: account.settings || {},
    methods: adapter ? adapter.availableMethods(account.settings || {}) : [],
    webhookUrl: webhookUrlFor(account),
    lastVerifiedAt: account.lastVerifiedAt,
    lastWebhookAt: account.lastWebhookAt,
    connectedAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function describeAdapter(adapter) {
  return {
    code: adapter.code,
    name: adapter.name,
    methods: adapter.methods,
    currencies: adapter.currencies,
    credentialFields: adapter.credentialFields,
    settingFields: adapter.settingFields,
    setupSteps: adapter.setupSteps,
    helpLinks: adapter.helpLinks,
    webhookSetup: adapter.webhookSetup,
    // Card / wallet / … as this gateway's own account shows them: the methods
    // come from the account itself, nothing to type in.
    methodsFromAccount: adapter.settingFields.length === 0,
  };
}

async function listGateways(workspaceId) {
  const accounts = await db.PaymentGatewayAccount.findAll({ where: { workspaceId } });
  const byCode = new Map(accounts.map((a) => [a.providerCode, a]));
  return {
    configured: isConfigured(),
    onlineEnabled: env.payments.onlineEnabled,
    gateways: gateways.listAdapters().map((adapter) => ({
      ...describeAdapter(adapter),
      connection: describeConnection(byCode.get(adapter.code)),
    })),
  };
}

function validatePart(schema, value, prefix) {
  const { error, value: clean } = schema.validate(value, { abortEarly: false, stripUnknown: true });
  if (error) {
    throw new ValidationError(
      error.details.map((d) => ({ field: `${prefix}.${d.path.join('.')}`, message: d.message })),
      'Invalid body'
    );
  }
  return clean;
}

function decryptFor(account) {
  assertConfigured();
  try {
    return cipher.decrypt(account.credentialsEncrypted, aadFor(account.workspaceId, account.providerCode), credentialsKey());
  } catch (err) {
    logger.error('Could not decrypt gateway credentials', {
      workspaceId: account.workspaceId,
      providerCode: account.providerCode,
      reason: err.message,
    });
    throw new AppError(
      'GATEWAY_CREDENTIALS_UNREADABLE',
      'The saved keys for this gateway can no longer be read. Connect the account again.',
      409
    );
  }
}

async function loadWithCredentials(where) {
  return db.PaymentGatewayAccount.scope('withCredentials').findOne({ where });
}

/**
 * Connect or update. `credentials` is required on first connect; on an update
 * without it the stored keys are re-verified with the new settings.
 */
async function connect(workspaceId, code, body, req) {
  assertConfigured();
  const adapter = requireAdapter(code);
  const existing = await loadWithCredentials({ workspaceId, providerCode: code });

  if (!body.credentials && !existing) {
    throw new ValidationError([{ field: 'credentials', message: '"credentials" is required to connect' }], 'Invalid body');
  }

  let settings = validatePart(adapter.settingsSchema, body.settings || (existing ? existing.settings : {}), 'settings');
  // A gateway whose methods the merchant types in (Paymob's integration IDs)
  // is checked before any call; one whose methods come from the gateway
  // (Kashier) after verifying, below.
  if (adapter.settingFields.length > 0 && adapter.availableMethods(settings).length === 0) {
    throw new ValidationError(
      [{ field: 'settings', message: 'Enter the integration ID of at least one payment method' }],
      'Invalid body'
    );
  }
  let credentials = body.credentials
    ? validatePart(adapter.credentialsSchema, body.credentials, 'credentials')
    : decryptFor(existing);

  let mode;
  try {
    const verified = await adapter.verifyCredentials(credentials, settings);
    mode = verified.mode;
    if (verified.credentials) credentials = verified.credentials;
    if (verified.settings) settings = { ...settings, ...verified.settings };
  } catch (err) {
    // The STORED keys failing is a revoked key, not a typo: mark the account.
    if (err instanceof GatewayAuthError && !body.credentials && existing) {
      await existing.update({ status: 'invalid' });
    }
    throw err;
  }
  if (adapter.availableMethods(settings).length === 0) {
    throw new ValidationError(
      [{ field: 'settings', message: `This ${adapter.name} account takes neither card nor wallet payments` }],
      'Invalid body'
    );
  }

  const values = {
    credentialsEncrypted: cipher.encrypt(credentials, aadFor(workspaceId, code), credentialsKey()),
    settings,
    mode,
    status: 'active',
    lastVerifiedAt: new Date(),
  };

  const account = await db.sequelize.transaction(async (transaction) => {
    let row;
    let action;
    let before = null;
    if (existing) {
      before = { mode: existing.mode, settings: existing.settings, status: existing.status };
      await existing.update(values, { transaction });
      row = existing;
      action = 'payment_gateway.update';
    } else {
      row = await db.PaymentGatewayAccount.create(
        { workspaceId, providerCode: code, webhookToken: newWebhookToken(), ...values },
        { transaction }
      );
      action = 'payment_gateway.connect';
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action,
      entityType: 'PaymentGatewayAccount',
      entityId: row.id,
      before,
      after: { providerCode: code, mode, settings, status: 'active', credentialsUpdated: Boolean(body.credentials) },
      req,
      transaction,
    });
    return row;
  });

  return { ...describeAdapter(adapter), connection: describeConnection(account) };
}

/**
 * Refused while an online order through this gateway is still waiting on its
 * payment: without the keys we could no longer ask the gateway about it, and
 * could never safely expire it.
 */
async function disconnect(workspaceId, code, req) {
  requireAdapter(code);
  return db.sequelize.transaction(async (transaction) => {
    const account = await db.PaymentGatewayAccount.findOne({
      where: { workspaceId, providerCode: code },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!account) throw new NotFoundError('Payment gateway connection');

    const pending = await db.Payment.count({
      where: { workspaceId, providerCode: code, status: 'initialized' },
      include: [
        {
          model: db.Order,
          as: 'order',
          required: true,
          where: { cancelledAt: null, financialState: { [Op.notIn]: ['paid', 'partially_paid', 'refunded', 'partially_refunded'] } },
        },
      ],
      transaction,
    });
    if (pending > 0) {
      throw new AppError(
        'GATEWAY_HAS_PENDING_PAYMENTS',
        `${pending} order(s) are still waiting on a payment through this gateway. Wait for them to be paid or expire, then disconnect.`,
        409
      );
    }

    await account.destroy({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'payment_gateway.disconnect',
      entityType: 'PaymentGatewayAccount',
      entityId: account.id,
      before: { providerCode: code, mode: account.mode, settings: account.settings },
      req,
      transaction,
    });
    return { disconnected: true };
  });
}

/** The account plus decrypted credentials, for a gateway call. */
async function loadAccountForCalls(workspaceId, code) {
  assertConfigured();
  const account = await loadWithCredentials({ workspaceId, providerCode: code });
  if (!account) {
    throw new AppError('GATEWAY_NOT_CONNECTED', 'This payment gateway is not connected for the store', 409);
  }
  return {
    id: account.id,
    workspaceId: account.workspaceId,
    providerCode: account.providerCode,
    mode: account.mode,
    status: account.status,
    settings: account.settings || {},
    credentials: decryptFor(account),
    webhookUrl: webhookUrlFor(account),
  };
}

/** Webhook lookup: the account a callback URL's token belongs to, with credentials, or null. */
async function findByWebhookToken(code, token) {
  if (!token || typeof token !== 'string' || token.length > 64) return null;
  const account = await loadWithCredentials({ providerCode: code, webhookToken: token });
  if (!account) return null;
  return {
    id: account.id,
    workspaceId: account.workspaceId,
    providerCode: account.providerCode,
    mode: account.mode,
    settings: account.settings || {},
    credentials: decryptFor(account),
    row: account,
  };
}

async function listAccounts(workspaceId) {
  return db.PaymentGatewayAccount.findAll({ where: { workspaceId, status: 'active' } });
}

module.exports = {
  isConfigured,
  assertConfigured,
  webhookUrlFor,
  listGateways,
  connect,
  disconnect,
  loadAccountForCalls,
  findByWebhookToken,
  listAccounts,
};
