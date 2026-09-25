'use strict';

const paymob = require('./paymob');

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
 *   webhookSetup       { field, perIntegration } — where the merchant pastes our URL
 *   credentialsSchema, settingsSchema   Joi
 *
 * Every function receives the DECRYPTED credentials first. Never log them.
 * Errors come from ./gatewayErrors: GatewayAuthError (keys refused),
 * GatewayRejectedError (a definite refusal), GatewayError (no definite
 * answer). All HTTP goes through ./gatewayHttp.request.
 *
 *   modeFromCredentials(creds) -> 'test' | 'live'
 *   availableMethods(settings) -> the methods these settings can take
 *   verifyCredentials(creds, settings) -> { mode }
 *   createPayment(creds, { attempt, order, method, settings, returnUrl,
 *                          webhookUrl, expiresInSeconds, storeName })
 *       -> { providerOrderId, providerReference, redirectUrl }
 *   inquire(creds, { payment }) -> { found: false } | { found: true, transaction, payload }
 *   inquireTransaction(creds, { transactionId }) -> transaction | null
 *   refund(creds, { payment, amount }) -> { status, providerRefundReference, failureReason }
 *   parseWebhook({ query, body }, creds) -> null | { valid, eventKey, transaction, payload }
 *   parseRedirect(query, creds)          -> null | { valid, eventKey, transaction, payload }
 *
 * `transaction` (normalized): { kind: 'payment'|'refund'|'void', status,
 *   transactionId, parentTransactionId, providerOrderId, amount, currency,
 *   maskedDisplay, failureReason }. Payment status: 'paid'|'failed'|'pending';
 *   refund / void status: 'processed'|'failed'|'pending'.
 */
const ADAPTERS = {
  [paymob.code]: paymob,
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
