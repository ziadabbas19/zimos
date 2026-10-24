'use strict';

const env = require('../../../config/env');
const paymob = require('./paymob');
const kashier = require('./kashier');
const fawaterak = require('./fawaterak');

/**
 * Online payment gateways a merchant connects with their own account: one
 * file per gateway, registered below. The money goes to the merchant's
 * gateway account; we never hold it.
 *
 * `cod` and `mock` are not gateways. They stay in payments/providers and keep
 * their single-step behaviour (see paymentService).
 *
 * Callers use the functions below as `gateways.getAdapter(...)`, never
 * destructured, so a test can stub the registry with jest.spyOn.
 *
 * ---------------------------------------------------------------------------
 * Adapter interface
 * ---------------------------------------------------------------------------
 * Descriptive fields (the dashboard's connect form is built from these)
 *   code, name, methods (['card', 'wallet']), currencies
 *   credentialFields   [{ key, secret, label: { en, ar }, placeholder? }]
 *   settingFields      [{ key, method?, type, label: { en, ar } }]
 *   setupSteps         { en: [...], ar: [...] }
 *   helpLinks          [{ label: { en, ar }, url }]
 *   webhookSetup       { field, perIntegration, automatic? } — where the merchant
 *                      pastes our URL; `automatic`: the gateway is given it with
 *                      every payment, so pasting it is optional
 *   webhookDuplicateStatus?  the HTTP status a repeated callback is answered
 *                      with (default 200)
 *   webhookVariants?   extra last path segments the webhook URL may carry
 *                      (Fawaterak's `paid_json`)
 *   webhookConfirmsByInquiry?  true: the webhook's signature does not cover the
 *                      outcome, so a verified webhook only names the payment
 *                      and the gateway is asked about it (inquire)
 *   refundsInGatewayDashboard?  true: refunds are made in the gateway's own
 *                      dashboard; ours sends none
 *   credentialsSchema, settingsSchema   Joi
 *
 * Every function receives the DECRYPTED credentials first. Never log them.
 * Errors come from ./gatewayErrors: GatewayAuthError (keys refused),
 * GatewayRejectedError (a definite refusal), GatewayError (no definite
 * answer). All HTTP goes through ./gatewayHttp.request.
 *
 *   modeFromCredentials(creds) -> 'test' | 'live'
 *   availableMethods(settings) -> the methods these settings can take
 *   connectionNotices?(settings) -> warning codes the dashboard shows
 *   accountOf?(creds) -> which gateway account the keys are; with it, new keys
 *       for ANOTHER account are refused while a payment is still open
 *       (GATEWAY_SWITCH_HAS_PENDING_PAYMENTS), as disconnect is
 *   verifyCredentials(creds, settings) -> { mode, credentials?, settings? }
 *       `credentials` / `settings`, when returned, are what gets stored (a
 *       gateway whose keys do not show their mode records it there)
 *   createPayment(creds, { attempt, order, method, settings, returnUrl,
 *                          webhookUrl, expiresInSeconds, storeName, locale })
 *       -> { providerOrderId, providerReference, redirectUrl }
 *   inquire(creds, { payment }) -> { found: false } | { found: true, transaction, payload }
 *   inquireTransaction(creds, { transactionId, payment }) -> transaction | null
 *   refund(creds, { payment, amount }) -> { status, providerRefundReference, failureReason, failureCode? }
 *   parseWebhook({ query, body, headers }, creds) -> null | { valid, eventKey, transaction, payload }
 *   parseRedirect(query, creds)          -> null | { valid, eventKey, transaction, payload }
 *
 * `transaction` (normalized): { kind: 'payment'|'refund'|'void', status,
 *   transactionId, parentTransactionId, providerOrderId, amount, currency,
 *   maskedDisplay, failureReason, failureCode? }. Payment status:
 *   'paid'|'failed'|'pending'; refund / void status: 'processed'|'failed'|'pending'.
 *   A refund without parentTransactionId is matched to its payment by
 *   providerOrderId (Kashier's refund notifications name the order only).
 */
const ADAPTERS = {
  [paymob.code]: paymob,
  [kashier.code]: kashier,
  [fawaterak.code]: fawaterak,
};

/**
 * Which stores a gateway is offered to: connecting it, the gateway list, its
 * methods at checkout. Paymob and Kashier: every store. Fawaterak:
 * PAYMENTS_FAWATERAK_ENABLED, and then only the stores in
 * PAYMENTS_FAWATERAK_BETA_WORKSPACES when that is set (env.payments). The
 * list holds workspace ids, never slugs: a merchant can change their slug,
 * so a slug left in the list (a typo, a store renamed) could be taken by
 * another store. An entry that is not an id matches no store.
 *
 * getAdapter, isGateway and listAdapters are deliberately NOT limited by
 * this: a payment already started through a gateway is still recorded,
 * inquired, expired, swept and refunded after the gateway is switched off.
 */
const ROLLOUTS = {
  [fawaterak.code]: {
    read: () => env.payments.fawaterak,
    enabledVar: 'PAYMENTS_FAWATERAK_ENABLED',
    betaVar: 'PAYMENTS_FAWATERAK_BETA_WORKSPACES',
  },
};

const rolloutOf = (code) => (Object.prototype.hasOwnProperty.call(ROLLOUTS, code) ? ROLLOUTS[code] : null);

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 'all' | 'beta' | 'off': who may see the gateway on this server. */
function serverRollout(code) {
  if (!module.exports.getAdapter(code)) return 'off';
  const rollout = rolloutOf(code);
  if (!rollout) return 'all';
  const { enabled, betaWorkspaces } = rollout.read();
  if (enabled !== true) return 'off';
  return betaWorkspaces.length > 0 ? 'beta' : 'all';
}

/**
 * A gateway's own switch, for the platform admin: null when it has none
 * (offered to every store); otherwise its state, the variable names, the
 * beta workspace ids, and the entries that are not ids (they match nothing).
 */
function describeRollout(code) {
  const rollout = rolloutOf(code);
  if (!rollout) return null;
  const entries = [...rollout.read().betaWorkspaces];
  return {
    state: serverRollout(code),
    enabledVar: rollout.enabledVar,
    betaVar: rollout.betaVar,
    betaWorkspaces: entries.filter((e) => WORKSPACE_ID.test(e)),
    ignoredBetaEntries: entries.filter((e) => !WORKSPACE_ID.test(e)),
  };
}

/** Whether a store (`workspace.id`) may see the gateway. */
function isOfferedTo(code, workspace) {
  const state = serverRollout(code);
  if (state === 'all') return true;
  if (state === 'off' || !workspace || !workspace.id) return false;
  return rolloutOf(code).read().betaWorkspaces.includes(String(workspace.id).toLowerCase());
}

/** The gateways switched on for at least one store on this server. */
function listOfferedAdapters() {
  return module.exports.listAdapters().filter((adapter) => serverRollout(adapter.code) !== 'off');
}

function getAdapter(code) {
  if (!code) return null;
  return Object.prototype.hasOwnProperty.call(ADAPTERS, code) ? ADAPTERS[code] : null;
}

function isGateway(code) {
  return module.exports.getAdapter(code) !== null;
}

function listAdapters() {
  return Object.values(ADAPTERS);
}

module.exports = {
  getAdapter,
  isGateway,
  listAdapters,
  serverRollout,
  describeRollout,
  isOfferedTo,
  listOfferedAdapters,
  ADAPTERS,
};
