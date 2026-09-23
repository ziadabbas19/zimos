'use strict';

const Joi = require('joi');
const carrierHttp = require('./carrierHttp');
const { CarrierAuthError, CarrierPermissionError, CarrierError, sanitizeCarrierMessage } = require('./carrierErrors');
const { AppError } = require('../../../core/errors/AppError');
const { assertInt } = require('../../../core/utils/money');
const { normalizePhone } = require('../../../core/utils/phone');
const logger = require('../../../core/utils/logger');

/**
 * Bosta (Egypt) adapter. Every endpoint, field and state code here is taken
 * from Bosta's own documentation, fetched 2026-09-23:
 *
 *   OpenAPI spec   https://docs.bosta.co/api/api.yaml   (served by https://docs.bosta.co/api)
 *   API key        https://docs.bosta.co/docs/how-to/get-your-api-key
 *   Create order   https://docs.bosta.co/docs/how-to/create-your-first-delivery
 *   Webhooks       https://docs.bosta.co/docs/how-to/get-delivery-status-via-webhook
 *   Addresses      https://docs.bosta.co/docs/how-to/format-bosta-address
 *   AWB            https://docs.bosta.co/docs/how-to/print-awbs
 *
 * Auth: the API key goes in the `Authorization` header as-is — no "Bearer".
 * Key scopes: Read Only (GET), Read/Write (no DELETE), Full Access. Creating
 * needs Read/Write; cancelling (terminate is a DELETE) needs Full Access.
 *
 * Every response is `{ success, message, errorCode?, data }`. 401 / errorCode
 * 1007 is "User is not authorized!"; 403 / 1008 is a scope refusal.
 */

const BASE_URL = 'https://app.bosta.co/api/v2';
// Egypt's country id, from the address guide — the only country Bosta serves.
const EGYPT_COUNTRY_ID = '60e4482c7cb7d4bc4849c4d5';
// "The COD amount should be less than or equal 30000 EGP" (error 3007).
const MAX_COD_EGP = 30000;
// Order type "Deliver" — the only type this integration creates.
const DELIVERY_TYPE_DELIVER = 10;
const PACKAGE_TYPES = ['Parcel', 'Document', 'Light Bulky', 'Heavy Bulky'];

/**
 * Bosta state code -> our Shipment status, for the orders we create (type
 * Deliver, which Bosta's webhook calls SEND; a failed one comes back as RTO).
 * From the "Bosta States" table on the webhooks page.
 *
 *   a status string   move the shipment there
 *   null              documented, but says nothing about where the parcel is:
 *                     keep the current status, quietly
 *   (absent)          not a state a Deliver order should ever report: keep the
 *                     current status and log a warning
 */
const STATE_MAP = {
  // Still with the merchant: pickup requested, then a courier assigned to
  // collect it.
  10: 'created', //  Pickup requested
  20: 'created', //  Route Assigned

  // Collected from the merchant, moving through Bosta's network.
  21: 'picked_up', //  Picked up from business
  24: 'in_transit', //  Received at warehouse
  30: 'in_transit', //  In transit between Hubs

  // 41 "Picked up" means different things by order type (webhooks page, "More
  // Info"): out for delivery for SEND, out for return for RTO. Resolved in
  // mapState() below, not here.

  // Final outcomes of the delivery attempt.
  45: 'delivered', //  Delivered
  46: 'returned', //  Returned to business

  // The delivery is not going to happen (or not yet): a failed attempt, a
  // cancellation or a parcel that went missing. 49 "Canceled" is listed with
  // dashboard state "In progress", i.e. the parcel may still be inside Bosta's
  // network heading back — so it is 'failed' (still visible in the pipeline),
  // not our 'cancelled' (which the pipeline treats as "no shipment").
  47: 'failed', //  Exception (a failed attempt; Bosta may try again -> 41)
  49: 'failed', //  Canceled
  100: 'failed', // Lost
  101: 'failed', // Damaged
  103: 'failed', // Awaiting your action (return failed three times)

  // Ended at Bosta: pushed when a delivery is terminated — which is what our
  // cancel calls.
  48: 'cancelled', // Terminated

  // Documented, but no information about the parcel's position.
  102: null, // Investigation
  104: null, // Archived
  105: null, // On hold

  // Not mapped on purpose — they belong to order types we never create:
  //   11 Waiting for route, 40 Picking up          (Cash Collection)
  //   22 Picking up from consignee,
  //   23 Picked up from consignee                  (CRP / Exchange)
  //   25 Fulfilled, 60 Returned to stock           (Fulfillment)
};

/** One row per mapping, for the report / docs endpoint. */
const STATE_NAMES = {
  10: 'Pickup requested', 11: 'Waiting for route', 20: 'Route Assigned', 21: 'Picked up from business',
  22: 'Picking up from consignee', 23: 'Picked up from consignee', 24: 'Received at warehouse', 25: 'Fulfilled',
  30: 'In transit between Hubs', 40: 'Picking up', 41: 'Picked up', 45: 'Delivered', 46: 'Returned to business',
  47: 'Exception', 48: 'Terminated', 49: 'Canceled', 60: 'Returned to stock', 100: 'Lost', 101: 'Damaged',
  102: 'Investigation', 103: 'Awaiting your action', 104: 'Archived', 105: 'On hold',
};

/**
 * The order type as Bosta reports it: the webhook sends a string ("SEND",
 * "RTO", ...), the view-delivery API an object ({ code: 10, value: "Send" }).
 */
function legOf(type) {
  const value = type && typeof type === 'object' ? type.value : type;
  const code = type && typeof type === 'object' ? type.code : null;
  if (Number(code) === DELIVERY_TYPE_DELIVER || /^send$/i.test(String(value || ''))) return 'send';
  if (/^rto$/i.test(String(value || ''))) return 'return';
  return 'unknown';
}

/** { status } for a Bosta state; `status` undefined means "unknown, warn". */
function mapState(code, type) {
  const n = Number(code);
  if (n === 41) {
    const leg = legOf(type);
    if (leg === 'send') return { status: 'out_for_delivery' };
    // Heading back to the merchant after a failed delivery.
    if (leg === 'return') return { status: 'failed' };
    return { status: undefined };
  }
  if (Object.prototype.hasOwnProperty.call(STATE_MAP, n)) return { status: STATE_MAP[n] };
  return { status: undefined };
}

// --- request plumbing -------------------------------------------------------

function headers(creds) {
  return { Authorization: creds.apiKey };
}

function failFrom(res, creds, { action } = {}) {
  const body = res.json || {};
  const code = Number(body.errorCode);
  const message = sanitizeCarrierMessage(body.message, [creds && creds.apiKey]);
  if (res.status === 401 || code === 1007) return new CarrierAuthError('Bosta');
  if (res.status === 403 || code === 1008) {
    const hint =
      action === 'cancel'
        ? ' Cancelling a Bosta delivery needs an API key with Full Access.'
        : ' Check the API key\'s access level in Bosta\'s dashboard.';
    return new CarrierPermissionError(`Bosta refused this action for the connected API key.${hint}`);
  }
  return new CarrierError(message ? `Bosta: ${message}` : `Bosta returned HTTP ${res.status}`, {
    carrierErrorCode: Number.isFinite(code) ? code : null,
    httpStatus: res.status,
  });
}

async function call(creds, { method = 'GET', path, body, retry = false, action, timeoutMs }) {
  let res;
  try {
    res = await carrierHttp.request({ method, url: `${BASE_URL}${path}`, headers: headers(creds), body, retry, timeoutMs });
  } catch (err) {
    if (action === 'create') {
      // No answer to a create: Bosta may or may not have the delivery. We
      // record nothing, so say where to look before booking again.
      throw new CarrierError(
        `Bosta did not respond (${err.message || 'network error'}). The delivery may still have been created — ` +
          'check your Bosta dashboard before booking this order again.'
      );
    }
    throw new CarrierError(`Bosta did not respond (${err.message || 'network error'})`);
  }
  if (!res.ok || !res.json || res.json.success === false) throw failFrom(res, creds, { action });
  return res.json.data;
}

// --- mapping helpers --------------------------------------------------------

/** Our minor units (piastres) -> Bosta's `cod`, which is in EGP. */
function toEgp(minor) {
  return assertInt(minor, 'cod') / 100;
}

/** Bosta's examples use Egyptian local format: 01065685435. */
function localPhone(raw) {
  const digits = normalizePhone(raw);
  if (digits && digits.startsWith('20') && digits.length === 12) return `0${digits.slice(2)}`;
  return raw ? String(raw) : raw;
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Customer' };
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// The raw objects we keep on the shipment. A whitelist, not a blacklist:
// Bosta's responses also carry the sender's and account holder's phones.
function pickDelivery(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    _id: data._id || null,
    trackingNumber: data.trackingNumber != null ? String(data.trackingNumber) : null,
    businessReference: data.businessReference || null,
    state: data.state || null,
    type: data.type || null,
    maskedState: data.maskedState || null,
  };
}

// --- the adapter ------------------------------------------------------------

const credentialsSchema = Joi.object({
  apiKey: Joi.string().trim().min(10).max(500).required(),
});

const settingsSchema = Joi.object({
  // Which of the merchant's Bosta pickup locations parcels are collected
  // from; Bosta uses the default location when absent.
  businessLocationId: Joi.string().trim().max(100).allow(null, '').optional(),
  packageType: Joi.string().valid(...PACKAGE_TYPES).optional(),
  // Label (AWB) print options, from the mass-awb endpoint.
  awbType: Joi.string().valid('A4', 'A6').optional(),
  awbLang: Joi.string().valid('ar', 'en').optional(),
});

/**
 * GET /pickup-locations is the cheapest authenticated call Bosta documents,
 * and needs only a Read Only key. Returns the locations so the connect screen
 * can offer them, and checks a chosen businessLocationId really exists.
 */
async function verifyCredentials(creds, settings = {}) {
  const data = await call(creds, { path: '/pickup-locations', retry: true });
  const list = Array.isArray(data && data.list) ? data.list : [];
  const pickupLocations = list.map((loc) => ({
    id: loc._id,
    name: loc.locationName || null,
    isDefault: Boolean(loc.isDefault),
  }));
  if (settings.businessLocationId && !pickupLocations.some((loc) => loc.id === settings.businessLocationId)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Validation failed',
      422,
      [{ field: 'settings.businessLocationId', message: 'Not one of this Bosta account\'s pickup locations' }]
    );
  }
  return { pickupLocations };
}

/**
 * Every city with its districts, from GET /cities/getAllDistricts — one call
 * instead of one per city. Bosta addresses are city + district (the zone is
 * optional and comes along on each district row).
 */
async function listCities(creds) {
  const data = await call(creds, { path: `/cities/getAllDistricts?countryId=${EGYPT_COUNTRY_ID}`, retry: true });
  const rows = Array.isArray(data) ? data : [];
  return rows
    .filter((city) => city && city.cityId)
    .map((city) => ({
      id: city.cityId,
      name: city.cityName || null,
      nameAr: city.cityOtherName || null,
      dropOffAvailable: city.dropOffAvailability !== false,
      districts: (Array.isArray(city.districts) ? city.districts : [])
        .filter((d) => d && d.districtId)
        .map((d) => ({
          id: d.districtId,
          name: d.districtName || null,
          nameAr: d.districtOtherName || null,
          zoneId: d.zoneId || null,
          zoneName: d.zoneName || null,
          zoneNameAr: d.zoneOtherName || null,
          dropOffAvailable: d.dropOffAvailability !== false,
        })),
    }));
}

/**
 * POST /deliveries?apiVersion=1, type 10 (Deliver). Called once — never
 * retried (see carrierHttp).
 *
 * @param {object} input
 * @param {object} input.order          Order row (contact/address snapshots, items)
 * @param {object} input.address        { cityName, districtId, zoneId?, firstLine, secondLine? }
 * @param {number} input.cod            amount to collect, OUR minor units
 * @param {number} input.goodsValue     declared item value, our minor units
 * @param {number} input.itemsCount
 * @param {string} input.description
 * @param {string} [input.notes]
 * @param {object} [input.carrierSettings]
 * @param {string} [input.webhookUrl]   per-delivery status webhook
 */
async function createShipment(creds, input) {
  const { order, address, cod, goodsValue, itemsCount, description, notes, carrierSettings = {}, webhookUrl } = input;

  if (order.currency !== 'EGP') {
    throw new AppError('CARRIER_CURRENCY_UNSUPPORTED', 'Bosta only collects cash in EGP; this order is in another currency', 422);
  }
  const codEgp = toEgp(cod);
  if (codEgp > MAX_COD_EGP) {
    throw new AppError('CARRIER_COD_LIMIT', `Bosta collects at most ${MAX_COD_EGP} EGP cash on delivery`, 422);
  }
  // "Address line 1 (Required, and must be more than 5 characters)".
  if (!address.firstLine || address.firstLine.trim().length <= 5) {
    throw new AppError('VALIDATION_ERROR', 'Validation failed', 422, [
      { field: 'shippingAddress.addressLine', message: 'Bosta needs a street address longer than 5 characters' },
    ]);
  }

  const contact = order.contactSnapshot || {};
  const body = {
    type: DELIVERY_TYPE_DELIVER,
    cod: codEgp,
    specs: {
      packageType: carrierSettings.packageType || 'Parcel',
      packageDetails: { itemsCount, description: description.slice(0, 250) },
    },
    goodsInfo: { amount: toEgp(goodsValue) },
    dropOffAddress: {
      city: address.cityName,
      districtId: address.districtId,
      ...(address.zoneId ? { zoneId: address.zoneId } : {}),
      firstLine: address.firstLine.trim(),
      ...(address.secondLine ? { secondLine: address.secondLine } : {}),
    },
    receiver: {
      ...splitName(contact.fullName),
      phone: localPhone(contact.phone),
      ...(contact.alternatePhone ? { secondPhone: localPhone(contact.alternatePhone) } : {}),
      ...(contact.email ? { email: contact.email } : {}),
    },
    businessReference: order.orderNumber,
    ...(notes ? { notes: String(notes).slice(0, 500) } : {}),
    ...(carrierSettings.businessLocationId ? { businessLocationId: carrierSettings.businessLocationId } : {}),
    ...(webhookUrl ? { webhookUrl } : {}),
  };

  const data = await call(creds, {
    method: 'POST',
    path: '/deliveries?apiVersion=1',
    body,
    action: 'create',
    timeoutMs: carrierHttp.CREATE_TIMEOUT_MS,
  });
  if (!data || data.trackingNumber == null) {
    throw new CarrierError('Bosta accepted the delivery but returned no tracking number');
  }
  return {
    trackingNumber: String(data.trackingNumber),
    carrierShipmentId: data._id || null,
    // Bosta's API documents no public tracking-page URL per delivery.
    trackingUrl: null,
    labelUrl: null,
    raw: pickDelivery(data),
  };
}

/** GET /deliveries/business/{trackingNumber}. */
async function getShipment(creds, trackingNumber) {
  const data = await call(creds, { path: `/deliveries/business/${encodeURIComponent(trackingNumber)}`, retry: true });
  const code = data && data.state ? data.state.code : undefined;
  const { status } = mapState(code, data && data.type);
  if (status === undefined) {
    logger.warn('Unmapped Bosta delivery state — shipment status left unchanged', {
      trackingNumber: String(trackingNumber),
      stateCode: code,
      type: data && data.type,
    });
  }
  return {
    // null = "no change"; undefined is folded into null for callers.
    status: status || null,
    carrierStatus: {
      code: code != null ? Number(code) : null,
      value: (data && data.state && data.state.value) || STATE_NAMES[Number(code)] || null,
      type: data && data.type ? data.type : null,
    },
    raw: pickDelivery(data),
  };
}

/** DELETE /deliveries/business/{trackingNumber}/terminate (Full Access key). */
async function cancelShipment(creds, trackingNumber) {
  await call(creds, {
    method: 'DELETE',
    path: `/deliveries/business/${encodeURIComponent(trackingNumber)}/terminate`,
    action: 'cancel',
  });
}

/**
 * POST /deliveries/mass-awb for one tracking number. Bosta documents the
 * answer for <= 50 AWBs only as "a base64 encoded pdf file", without saying
 * whether it is wrapped in the usual { data } envelope — both shapes are
 * accepted, and the result must actually be a PDF.
 */
async function getLabel(creds, trackingNumber, carrierSettings = {}) {
  let res;
  try {
    res = await carrierHttp.request({
      method: 'POST',
      url: `${BASE_URL}/deliveries/mass-awb`,
      headers: headers(creds),
      body: {
        trackingNumbers: String(trackingNumber),
        requestedAwbType: carrierSettings.awbType || 'A4',
        lang: carrierSettings.awbLang || 'ar',
      },
    });
  } catch (err) {
    throw new CarrierError(`Bosta did not respond (${err.message || 'network error'})`);
  }
  if (!res.ok || (res.json && res.json.success === false)) throw failFrom(res, creds);

  let encoded = null;
  if (res.json && typeof res.json === 'object' && typeof res.json.data === 'string') encoded = res.json.data;
  else if (typeof res.json === 'string') encoded = res.json;
  else if (!res.json && res.text) encoded = res.text.trim();

  const pdf = encoded ? Buffer.from(encoded.replace(/^data:application\/pdf;base64,/, ''), 'base64') : null;
  if (!pdf || pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new CarrierError('Bosta did not return a printable label for this shipment');
  }
  return pdf;
}

/**
 * The webhook body carries `_id`, `trackingNumber`, `state`, `type`, ... We
 * take ONLY the tracking number; the state is re-read from Bosta's API.
 */
function parseWebhook(req) {
  const body = req.body || {};
  const ref = body.trackingNumber != null ? String(body.trackingNumber).trim() : '';
  if (!/^[A-Za-z0-9-]{1,40}$/.test(ref)) return null;
  return { ref };
}

module.exports = {
  code: 'bosta',
  name: 'Bosta',
  // Bosta accepts a webhookUrl on every delivery we create, so nothing has to
  // be pasted into Bosta's dashboard.
  webhookSetup: 'per_shipment',
  credentialFields: [{ key: 'apiKey', label: 'API key', secret: true }],
  settingFields: [
    { key: 'businessLocationId', label: 'Pickup location' },
    { key: 'packageType', label: 'Package type', options: PACKAGE_TYPES },
    { key: 'awbType', label: 'Label size', options: ['A4', 'A6'] },
    { key: 'awbLang', label: 'Label language', options: ['ar', 'en'] },
  ],
  supportsLabel: true,
  credentialsSchema,
  settingsSchema,
  verifyCredentials,
  listCities,
  createShipment,
  getShipment,
  cancelShipment,
  getLabel,
  parseWebhook,
  // Exposed for tests and the docs.
  STATE_MAP,
  STATE_NAMES,
  mapState,
  toEgp,
  BASE_URL,
};
