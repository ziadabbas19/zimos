'use strict';

const { AppError } = require('../../core/errors/AppError');
const gateways = require('./gateways');

/**
 * Everything a call to a merchant's gateway needs: the adapter and the
 * account it acts for. The account side (decrypted credentials, mode) is
 * resolved by gatewayAccountService.
 *
 * Goes through module.exports so tests can stub it.
 */
async function contextFor(workspaceId, providerCode) {
  const adapter = gateways.getAdapter(providerCode);
  if (!adapter) {
    throw new AppError('UNKNOWN_PAYMENT_PROVIDER', `No payment provider configured for "${providerCode}"`, 400);
  }
  // Required lazily: the account service requires the registry and the
  // cipher, and nothing on the COD path should load either.
  const accounts = require('./gatewayAccountService');
  const account = await accounts.loadAccountForCalls(workspaceId, providerCode);
  return { adapter, account, credentials: account.credentials, settings: account.settings, mode: account.mode };
}

/**
 * Asks the gateway to refund `amount` (our minor units) of a captured payment.
 * Resolves { status: 'processed' | 'pending' | 'failed', providerRefundReference?, failureReason? }.
 * Throws only when the outcome is unknown (no answer, a 5xx).
 */
async function refund(workspaceId, payment, amount) {
  const ctx = await module.exports.contextFor(workspaceId, payment.providerCode);
  return ctx.adapter.refund(ctx.credentials, { payment, amount, settings: ctx.settings });
}

module.exports = { contextFor, refund };
