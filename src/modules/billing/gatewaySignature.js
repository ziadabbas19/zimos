'use strict';

const logger = require('../../core/utils/logger');

/**
 * Placeholder webhook signature check. Returns true until a payment gateway is
 * chosen; implement the provider's real check here and update EVENT_STATUS_MAP
 * in billingService.js to its event names. Nothing else in the flow changes.
 */
function verifyGatewaySignature(payload, headers) {
  logger.warn('verifyGatewaySignature is not implemented — accepting billing webhooks unverified');
  return true;
}

module.exports = { verifyGatewaySignature };
