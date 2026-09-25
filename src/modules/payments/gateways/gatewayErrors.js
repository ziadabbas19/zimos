'use strict';

const { AppError } = require('../../../core/errors/AppError');

/**
 * Errors gateway adapters throw. All are AppErrors, so anything that escapes
 * reaches the client with a stable code. The difference that matters to the
 * callers is whether the gateway gave a definite answer:
 *
 *   GatewayAuthError        the credentials were refused — definite
 *   GatewayRejectedError    the gateway refused this request — definite (a
 *                           refund it declined, an amount it would not take)
 *   GatewayError            anything else, including no answer at all — the
 *                           outcome is UNKNOWN, and a refund or payment in
 *                           this state is settled later by inquire / webhook
 */

class GatewayAuthError extends AppError {
  constructor(gatewayName) {
    super(
      'GATEWAY_AUTH_FAILED',
      `${gatewayName} rejected these keys. Check them in your ${gatewayName} dashboard and connect again.`,
      422
    );
    this.name = 'GatewayAuthError';
  }
}

class GatewayRejectedError extends AppError {
  constructor(message, details) {
    super('GATEWAY_REJECTED', message, 422, details);
    this.name = 'GatewayRejectedError';
  }
}

class GatewayError extends AppError {
  constructor(message, details) {
    super('GATEWAY_ERROR', message, 502, details);
    this.name = 'GatewayError';
  }
}

/**
 * A gateway's error text, safe to show a merchant: any credential value that
 * might have been echoed back is cut out, control characters are dropped, and
 * the length is capped.
 */
function sanitizeGatewayMessage(message, secrets = []) {
  let text = typeof message === 'string' ? message : '';
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

module.exports = { GatewayAuthError, GatewayRejectedError, GatewayError, sanitizeGatewayMessage };
