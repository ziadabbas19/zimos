'use strict';

const bosta = require('./bosta');

/**
 * Courier adapters: one file per carrier, registered below. Adding J&T or
 * Aramex is a new file implementing the interface + one line in ADAPTERS;
 * the routes, services, webhook and tests are carrier-agnostic.
 *
 * 'manual' is not an adapter and never will be: it is a shipment the merchant
 * books themselves and types the waybill number into. Any carrierCode without
 * an adapter keeps that manual behaviour.
 *
 * ---------------------------------------------------------------------------
 * Adapter interface
 * ---------------------------------------------------------------------------
 * Descriptive fields
 *   code, name
 *   webhookSetup          'per_shipment' (URL sent on every create) |
 *                         'account' (merchant pastes the URL into the
 *                         carrier's dashboard once)
 *   credentialFields      [{ key, label, secret }] — for the connect form
 *   settingFields         [{ key, label, options? }]
 *   supportsLabel         whether getLabel exists
 *   credentialsSchema     Joi schema for the credentials object
 *   settingsSchema        Joi schema for carrier-specific settings
 *
 * Every function receives the DECRYPTED credentials first. Never log them.
 * Errors: throw CarrierAuthError (credentials rejected -> 422, account marked
 * invalid), CarrierPermissionError (key lacks the scope -> 422) or
 * CarrierError (anything else -> 502) from ./carrierErrors; messages must be
 * sanitised (sanitizeCarrierMessage). All HTTP goes through
 * ./carrierHttp.request — creates without retry, reads with retry.
 *
 *   verifyCredentials(creds, settings) -> { pickupLocations?: [...] }
 *   listCities(creds) -> [{ id, name, nameAr, dropOffAvailable,
 *                           districts: [{ id, name, nameAr, zoneId, zoneName,
 *                                         zoneNameAr, dropOffAvailable }] }]
 *   createShipment(creds, { order, address, cod, goodsValue, itemsCount,
 *                           description, notes, carrierSettings, webhookUrl })
 *       -> { trackingNumber, carrierShipmentId, trackingUrl?, labelUrl?, raw }
 *       `cod` and `goodsValue` are in OUR minor units; the adapter converts.
 *       `raw` is what gets stored on the shipment: whitelist, no PII/secrets.
 *   getShipment(creds, trackingNumber)
 *       -> { status, carrierStatus, raw }
 *       `status` is OUR Shipment status, or null when the carrier state says
 *       nothing we can act on (unknown states are logged by the adapter).
 *   cancelShipment(creds, trackingNumber) -> resolves, or throws if refused
 *   getLabel(creds, trackingNumber, settings) -> PDF Buffer (if supportsLabel)
 *   parseWebhook(req) -> { ref } | null
 *       ONLY the shipment identifier (the tracking number). The payload's
 *       status is never trusted; the webhook re-reads it with getShipment.
 */
const ADAPTERS = Object.freeze({
  [bosta.code]: bosta,
});

const MANUAL = 'manual';

function getAdapter(code) {
  if (!code || code === MANUAL) return null;
  return Object.prototype.hasOwnProperty.call(ADAPTERS, code) ? ADAPTERS[code] : null;
}

function listAdapters() {
  return Object.values(ADAPTERS);
}

module.exports = { getAdapter, listAdapters, MANUAL };
