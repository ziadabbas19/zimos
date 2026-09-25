'use strict';

const paymob = require('./paymob');
const kashier = require('./kashier');

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
 *   credentialsSchema, settingsSchema   Joi
 *
 * Every function receives the DECRYPTED credentials first. Never log them.
 * Errors come from ./gatewayErrors: GatewayAuthError (keys refused),
 * GatewayRejectedError (a definite refusal), GatewayError (no definite
 * answer). All HTTP goes through ./gatewayHttp.request.
 *
 *   modeFromCredentials(creds) -> 'test' | 'live'
 *   availableMethods(settings) -> the methods these settings can take
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
};

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

module.exports = { getAdapter, isGateway, listAdapters, ADAPTERS };
