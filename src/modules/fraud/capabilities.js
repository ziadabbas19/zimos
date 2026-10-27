'use strict';

const env = require('../../config/env');
const ipIntel = require('../risk/ipIntel');
const captcha = require('../risk/captcha');
const botProtection = require('../risk/botProtection');
const checkoutOtp = require('../risk/checkoutOtp');

/**
 * GET /workspaces/:workspaceId/fraud/capabilities — what the platform can
 * act on right now, so the dashboard's protection rules say which of them
 * do something and which are kept but have no effect:
 *
 *   botProtection.platformDefault   what an unset bot_protection means (BOT_PROTECTION_DEFAULT)
 *   ipIntel.provider                the IP lookup answering (IP_INTEL_PROVIDER), or null:
 *                                   without one, block_outside_country, block_vpn and
 *                                   blocked_countries never fire
 *   captcha.provider                the challenge verifier (CAPTCHA_PROVIDER), or null:
 *                                   without one, bot_captcha is skipped
 *   visitorGate.enabled             whether visit blocks act at all (VISITOR_GATE_ENABLED)
 *   networkDeliveryRate.available   false: no platform-wide delivery rate is computed, so
 *                                   min_network_delivery_rate never fires
 *   checkoutOtp                     whether WhatsApp and SMS codes can be delivered, and
 *                                   whether the delivery guard is on (risk/checkoutOtp)
 *
 * Platform settings only, the same for every store: no secret, no store data.
 */
function protectionCapabilities() {
  return {
    botProtection: { platformDefault: botProtection.platformDefaultOn() },
    ipIntel: { provider: ipIntel.providerName() },
    captcha: { provider: captcha.providerName() },
    visitorGate: { enabled: env.visitorGate.enabled },
    networkDeliveryRate: { available: false },
    checkoutOtp: checkoutOtp.deliveryStatus(),
  };
}

module.exports = { protectionCapabilities };
