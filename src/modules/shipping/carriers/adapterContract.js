'use strict';

/**
 * The contract every courier adapter is checked against when it is loaded.
 * defineAdapter() fills in the defaults, derives the descriptive fields the
 * dashboard already reads (webhookSetup, supportsLabel) from the
 * capabilities, and throws at require time when a capability is claimed
 * without the function that backs it — a half-written adapter never boots.
 *
 * Capabilities (all optional; defaults in DEFAULT_CAPABILITIES):
 *
 *   cancel          'api'    cancelShipment() cancels at the carrier
 *                   'manual' the carrier has no cancel API: the merchant
 *                            cancels in the carrier's dashboard and tells us
 *                            so (acknowledgeManualCancel), and we check back
 *                            later that it really happened
 *   label           getLabel() returns the carrier's own AWB PDF
 *   webhook         'per_shipment' (URL sent with every create) | 'account'
 *                   (merchant pastes it once) | 'none'
 *   webhookRefetch  true: the webhook payload only names the shipment and
 *                   the status is re-read with getShipment (never trust the
 *                   payload). false: parseWebhook's own status is applied —
 *                   only for a carrier whose webhooks are signed
 *                   (verifyWebhook required)
 *   polling         the carrier-sync cron may poll open shipments
 *   bulkStatus      getShipments(creds, refs) reads many in one call
 *   addressLevels   names of the carrier's address levels, top first. Two
 *                   levels named city/district keep the city/district API
 *                   (carrierAddress.cityId/districtId, the /cities list)
 *   reserveNameWhenUnconnected
 *                   the carrier's name is refused as a manual courier name
 *                   even on a store that has not connected it
 *
 * Tunables: pollIntervalMinutes (default 60), alreadyCancelledPattern (the
 * carrier's wording for "already cancelled" in a refused cancel), and
 * isCancelSettled(carrierStatus) — whether a carrier state leaves a cancel
 * nothing to stop.
 */

const DEFAULT_CAPABILITIES = Object.freeze({
  cancel: 'api',
  label: false,
  webhook: 'none',
  webhookRefetch: true,
  polling: false,
  bulkStatus: false,
  addressLevels: ['city', 'district'],
  reserveNameWhenUnconnected: false,
});

const DEFAULT_ALREADY_CANCELLED = /already\s+(been\s+)?(cancell?ed|terminated)/i;

const REQUIRED_FIELDS = ['code', 'name', 'credentialsSchema', 'settingsSchema', 'credentialFields', 'settingFields'];
const REQUIRED_FUNCTIONS = ['verifyCredentials', 'createShipment', 'getShipment'];

function fail(code, message) {
  throw new Error(`Carrier adapter "${code || '?'}": ${message}`);
}

/** True for the two-level city/district model the original API is built on. */
function isCityDistrict(levels) {
  return levels.length === 2 && levels[0] === 'city' && levels[1] === 'district';
}

function defineAdapter(spec) {
  const code = spec && spec.code;
  if (typeof code !== 'string' || !/^[a-z0-9_-]{1,50}$/.test(code)) fail(code, 'code must match [a-z0-9_-]{1,50}');
  if (code === 'manual') fail(code, '"manual" is reserved for shipments without an adapter');
  for (const key of REQUIRED_FIELDS) if (spec[key] == null) fail(code, `missing ${key}`);
  for (const key of REQUIRED_FUNCTIONS) if (typeof spec[key] !== 'function') fail(code, `missing ${key}()`);

  const capabilities = { ...DEFAULT_CAPABILITIES, ...(spec.capabilities || {}) };
  const unknown = Object.keys(capabilities).filter((k) => !(k in DEFAULT_CAPABILITIES));
  if (unknown.length) fail(code, `unknown capabilities: ${unknown.join(', ')}`);

  if (!['api', 'manual'].includes(capabilities.cancel)) fail(code, 'capabilities.cancel must be api or manual');
  if (capabilities.cancel === 'api' && typeof spec.cancelShipment !== 'function') {
    fail(code, 'cancel "api" needs cancelShipment()');
  }
  if (capabilities.label && typeof spec.getLabel !== 'function') fail(code, 'label needs getLabel()');
  if (!['per_shipment', 'account', 'none'].includes(capabilities.webhook)) {
    fail(code, 'capabilities.webhook must be per_shipment, account or none');
  }
  if (capabilities.webhook !== 'none' && typeof spec.parseWebhook !== 'function') {
    fail(code, 'a webhook needs parseWebhook()');
  }
  if (!capabilities.webhookRefetch && typeof spec.verifyWebhook !== 'function') {
    fail(code, 'trusting the webhook payload (webhookRefetch false) needs verifyWebhook()');
  }
  if (capabilities.bulkStatus && typeof spec.getShipments !== 'function') fail(code, 'bulkStatus needs getShipments()');

  const levels = capabilities.addressLevels;
  if (!Array.isArray(levels) || levels.length < 1 || levels.some((l) => typeof l !== 'string' || !l)) {
    fail(code, 'capabilities.addressLevels must be a non-empty list of level names');
  }
  if (isCityDistrict(levels)) {
    if (typeof spec.listCities !== 'function' && typeof spec.listAddressTree !== 'function') {
      fail(code, 'needs listCities() or listAddressTree()');
    }
  } else if (typeof spec.listAddressTree !== 'function') {
    fail(code, `${levels.length} address levels need listAddressTree()`);
  }

  const pollIntervalMinutes = spec.pollIntervalMinutes == null ? 60 : Number(spec.pollIntervalMinutes);
  if (!Number.isFinite(pollIntervalMinutes) || pollIntervalMinutes < 1) fail(code, 'pollIntervalMinutes must be >= 1');

  return Object.assign(spec, {
    capabilities: Object.freeze({ ...capabilities, addressLevels: Object.freeze([...levels]) }),
    // What the dashboard's connect card has always read.
    webhookSetup: capabilities.webhook,
    supportsLabel: Boolean(capabilities.label),
    nameAliases: spec.nameAliases || [],
    pollIntervalMinutes,
    alreadyCancelledPattern: spec.alreadyCancelledPattern || DEFAULT_ALREADY_CANCELLED,
  });
}

module.exports = { defineAdapter, isCityDistrict, DEFAULT_CAPABILITIES };
