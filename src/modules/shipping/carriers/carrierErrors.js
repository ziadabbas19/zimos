'use strict';

const { AppError } = require('../../../core/errors/AppError');

/**
 * Errors adapters throw. All are AppErrors, so anything that escapes reaches
 * the client with a stable code; the service layer additionally reacts to
 * CarrierAuthError by marking the account 'invalid'.
 */

/**
 * The carrier rejected the credentials themselves (e.g. revoked API key).
 * `what` names them for the merchant ("the username or password").
 */
class CarrierAuthError extends AppError {
  constructor(carrierName, what = 'the API key') {
    super(
      'CARRIER_AUTH_FAILED',
      `${carrierName} rejected ${what}. Check it in ${carrierName}'s dashboard and connect the account again.`,
      422
    );
    this.name = 'CarrierAuthError';
  }
}

/** Valid credentials whose scope doesn't allow this action. */
class CarrierPermissionError extends AppError {
  constructor(message) {
    super('CARRIER_PERMISSION_DENIED', message, 422);
    this.name = 'CarrierPermissionError';
  }
}

/** Anything else the carrier refused or failed at. */
class CarrierError extends AppError {
  constructor(message, details) {
    super('CARRIER_ERROR', message, 502, details);
    this.name = 'CarrierError';
  }
}

/**
 * A carrier's error text, safe to show a merchant: any credential value that
 * might have been echoed back is cut out, control characters are dropped, and
 * the length is capped.
 */
function sanitizeCarrierMessage(message, secrets = []) {
  let text = typeof message === 'string' ? message : '';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

module.exports = { CarrierAuthError, CarrierPermissionError, CarrierError, sanitizeCarrierMessage };
