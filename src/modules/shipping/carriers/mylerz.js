'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const carrierHttp = require('./carrierHttp');
const { CarrierAuthError, CarrierPermissionError, CarrierError, sanitizeCarrierMessage } = require('./carrierErrors');
const { AppError } = require('../../../core/errors/AppError');
const { assertInt } = require('../../../core/utils/money');
const { normalizePhone } = require('../../../core/utils/phone');
const logger = require('../../../core/utils/logger');
const { defineAdapter } = require('./adapterContract');

/**
 * Mylerz (Egypt) adapter. Sources, fetched 2026-09-26 — nothing else:
 *
 *   API reference   https://integration.mylerz.net/Help   (Mylerz's own ASP.NET
 *                   help pages: request/response schemas per endpoint, no
 *                   prose; e.g. /Help/Api/POST-api-Orders-AddOrders)
 *   Official plugin https://wordpress.org/plugins/mylerz/  (v5.0.5, author
 *                   "mylerz") — the only official source for the /token call,
 *                   the base URL and which endpoints a merchant integration
 *                   actually uses
 *
 * Auth: POST /token, form-encoded { grant_type: password, username,
 * password } — the merchant's own Mylerz credentials — answers an OAuth
 * `access_token`, sent as `Authorization: bearer <token>`.
 *
 * Every API response is `{ Value, CoreValue, IsErrorState, ErrorDescription,
 * ErrorMetadata }`; an unauthenticated call answers
 * `{ Message: "Authorization has been denied for this request." }`.
 *
 * Things the sources do not settle are marked "UNVERIFIED (n)" below; the
 * numbered list is in docs/carriers/mylerz.md.
 */

// Egypt's integration host, from the official plugin's readme. Mylerz
// publishes no sandbox host (UNVERIFIED 1).
const BASE_URL = 'https://integration.mylerz.net';

// PackageCodeRefDTO.Barcode: "Matching regular expression pattern: ^\d{14}$".
const BARCODE = /^\d{14}$/;

// OrderDTO enums, from the AddOrders schema.
const SERVICE_TYPES = ['DTD', 'DTC', 'CTD', 'CTC'];
const SERVICES = ['ND', 'SD'];

// OrderDTO field limits, from the AddOrders schema.
const LIMITS = { name: 200, email: 254, mobile: 20, street: 500, notes: 500, reference: 150, warehouse: 200 };
// OrderDTO.ValueOfGoods: "Range: inclusive between -999999 and 999999".
const MAX_GOODS_VALUE_EGP = 999999;

/**
 * Mylerz's package states. The schema documents `Status`, `StatusName`,
 * `StatusId`, `PhaseName` and `PhaseId` on GetPackageListStatus, but not one
 * of their values (UNVERIFIED 2). The only values any official source names
 * are the two `Status` strings the official plugin acts on:
 *
 *   'Delivered, Thank you :-)'          -> the plugin completes the order
 *   'Rejected - reason to be mentioned' -> the plugin cancels the order
 *
 * Everything else leaves our status where it is (null) and is logged, so the
 * merchant moves those shipments by hand. Keyed by the exact `Status` text.
 */
const STATE_MAP = {
  'Delivered, Thank you :-)': 'delivered',
  // The customer refused the parcel: it is heading back to the merchant,
  // which our pipeline calls 'failed' (still visible, can end 'returned').
  'Rejected - reason to be mentioned': 'failed',
};

// No documented state is known to be "cancelled at Mylerz" (UNVERIFIED 2),
// so a refused cancel is never treated as already settled from the state.
const CANCEL_SETTLED_STATES = [];

// --- auth ---------------------------------------------------------------------

// access_token per credential pair, in memory (per process), keyed by a hash
// of the username and password — never the password itself. A new password
// is a new key, so reconnecting never reuses the old account's token.
//
//   - reused until expires_in (less a minute) runs out
//   - a call refused with a CACHED token drops it, logs in once more and
//     repeats the call
//   - only a refused LOGIN is CarrierAuthError (the account is marked
//     invalid and polling for it stops); a call refused right after a
//     successful login is a permission problem, not bad credentials
const tokens = new Map();
// OAuth's expires_in is not documented for Mylerz (UNVERIFIED 3): without it
// a token is reused for an hour.
const DEFAULT_TOKEN_TTL_S = 3600;

const tokenKey = (creds) =>
  crypto.createHash('sha256').update(`${creds.username}\u0000${creds.password}`).digest('hex');

const secretsOf = (creds) => [creds && creds.password, creds && creds.username];

function clearTokens() {
  tokens.clear();
}

async function login(creds) {
  let res;
  try {
    res = await carrierHttp.request({
      method: 'POST',
      url: `${BASE_URL}/token`,
      form: { grant_type: 'password', username: creds.username, password: creds.password },
      // Asking for a token changes nothing at Mylerz.
      retry: true,
    });
  } catch (err) {
    throw new CarrierError(`Mylerz did not respond (${err.message || 'network error'})`);
  }
  const body = res.json || {};
  // The plugin also accepts `mylerz_access_token` in place of access_token.
  const token = body.access_token || body.mylerz_access_token;
  if (res.ok && token) {
    const ttl = Number(body.expires_in) > 60 ? Number(body.expires_in) : DEFAULT_TOKEN_TTL_S;
    return { token, expiresAt: Date.now() + (ttl - 60) * 1000 };
  }
  // OAuth password grant: a wrong username/password is 400 invalid_grant.
  // Mylerz's own wording is not documented (UNVERIFIED 4).
  if (res.status === 400 || res.status === 401 || body.error === 'invalid_grant') {
    throw new CarrierAuthError('Mylerz', 'the username or password');
  }
  const message = sanitizeCarrierMessage(body.error_description || body.error, secretsOf(creds));
  throw new CarrierError(message ? `Mylerz: ${message}` : `Mylerz returned HTTP ${res.status}`, { httpStatus: res.status });
}

/** { token, fresh }: `fresh` when this call just logged in. */
async function tokenFor(creds, { fresh = false } = {}) {
  const key = tokenKey(creds);
  const hit = tokens.get(key);
  if (!fresh && hit && hit.expiresAt > Date.now()) return { token: hit.token, fresh: false };
  tokens.delete(key);
  const got = await login(creds);
  tokens.set(key, got);
  return { token: got.token, fresh: true };
}

// --- request plumbing ---------------------------------------------------------

const DENIED = /authorization has been denied/i;
const isDenied = (res) => res.status === 401 || Boolean(res.json && DENIED.test(String(res.json.Message || '')));

function failFrom(res, creds) {
  const body = res.json || {};
  if (isDenied(res)) {
    // Reached only with a token Mylerz issued moments ago: the login works,
    // so the credentials are not what is wrong.
    return new CarrierPermissionError(
      'Mylerz accepted the username and password but refused this request. Ask Mylerz to enable API access for the account.'
    );
  }
  const message = sanitizeCarrierMessage(body.ErrorDescription || body.Message, secretsOf(creds));
  return new CarrierError(message ? `Mylerz: ${message}` : `Mylerz returned HTTP ${res.status}`, { httpStatus: res.status });
}

/**
 * One API call. Refused with a cached token (expired, revoked): log in again
 * once and repeat — a request refused at the door was not processed, so even
 * a create is safe to send again. Refused with a token from a login made for
 * this very call: no second login, it would not help.
 */
async function call(creds, { method = 'GET', path, body, retry = false, action, timeoutMs }) {
  const send = async (token) => {
    try {
      return await carrierHttp.request({
        method,
        url: `${BASE_URL}${path}`,
        headers: { Authorization: `bearer ${token}` },
        body,
        retry,
        timeoutMs,
      });
    } catch (err) {
      if (action === 'create') {
        throw new CarrierError(
          `Mylerz did not respond (${err.message || 'network error'}). The package may still have been created — ` +
            'check your Mylerz dashboard before booking this order again.'
        );
      }
      throw new CarrierError(`Mylerz did not respond (${err.message || 'network error'})`);
    }
  };

  const first = await tokenFor(creds);
  let res = await send(first.token);
  if (isDenied(res) && !first.fresh) {
    const retry = await tokenFor(creds, { fresh: true });
    res = await send(retry.token);
  }
  if (!res.ok || !res.json || res.json.IsErrorState === true || res.json.Message) throw failFrom(res, creds);
  return res.json.Value;
}

// --- mapping helpers --------------------------------------------------------------

/** Our minor units (piastres) -> EGP. */
function toEgp(minor, field = 'amount') {
  return assertInt(minor, field) / 100;
}

/**
 * Mobile_No is a string of at most 20 characters; its format is not
 * documented (UNVERIFIED 5). An Egyptian number goes in local form
 * (01XXXXXXXXX), as Egyptian couriers print it; anything we can't read as
 * a phone number is refused before Mylerz is called.
 */
function localPhone(raw, field) {
  const digits = normalizePhone(raw);
  if (!digits) {
    throw new AppError('VALIDATION_ERROR', 'Validation failed', 422, [
      { field, message: 'Mylerz needs a valid phone number for the customer' },
    ]);
  }
  const local = digits.startsWith('20') && digits.length === 12 ? `0${digits.slice(2)}` : `+${digits}`;
  if (local.length > LIMITS.mobile) {
    throw new AppError('VALIDATION_ERROR', 'Validation failed', 422, [
      { field, message: `Mylerz accepts phone numbers of at most ${LIMITS.mobile} characters` },
    ]);
  }
  return local;
}

const cut = (value, max) => (value == null ? value : String(value).slice(0, max));

/** { status } for a GetPackageListStatus row; undefined status = unknown. */
function mapStatus(row) {
  const text = row && row.Status != null ? String(row.Status).trim() : '';
  if (Object.prototype.hasOwnProperty.call(STATE_MAP, text)) return { status: STATE_MAP[text] };
  return { status: undefined };
}

// The raw object kept on the shipment: a whitelist. Mylerz's rows can carry
// the courier's name and phone (TrackPackages) and the customer's address.
function pickPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  return {
    barcode: pkg.BarCode != null ? String(pkg.BarCode) : null,
    reference: pkg.Reference || null,
    status: pkg.Status || null,
    destinationHubCode: pkg.DestinationHubCode || null,
  };
}

function pickStatus(row) {
  return {
    barcode: row.BarCode != null ? String(row.BarCode) : null,
    status: row.Status || null,
    statusId: row.StatusId != null ? Number(row.StatusId) : null,
    statusName: row.StatusName || null,
    phaseId: row.PhaseId != null ? Number(row.PhaseId) : null,
    phaseName: row.PhaseName || null,
    statusDate: row.StatusDate || null,
  };
}

function resultFrom(row) {
  const { status } = mapStatus(row);
  if (status === undefined) {
    logger.warn('Unmapped Mylerz package status — shipment status left unchanged', {
      trackingNumber: String(row.BarCode),
      status: row.Status,
      statusId: row.StatusId,
      phaseId: row.PhaseId,
    });
  }
  const raw = pickStatus(row);
  return {
    status: status || null,
    // `code` is what the shipment compares to notice a carrier-side move.
    carrierStatus: {
      code: raw.statusId != null ? raw.statusId : raw.status,
      value: raw.status || raw.statusName,
      phase: raw.phaseName,
    },
    raw,
  };
}

// --- the adapter ----------------------------------------------------------------

const credentialsSchema = Joi.object({
  username: Joi.string().trim().min(1).max(200).required(),
  password: Joi.string().min(1).max(200).required(),
});

const settingsSchema = Joi.object({
  // One of GetWarehouses' names (checked on connect). Absent: Mylerz's
  // default for the account (UNVERIFIED 6).
  warehouseName: Joi.string().trim().max(LIMITS.warehouse).allow(null, '').optional(),
  // Service_Type and Service; the official plugin defaults to DTD / ND.
  serviceType: Joi.string().valid(...SERVICE_TYPES).optional(),
  service: Joi.string().valid(...SERVICES).optional(),
  // Declared weight when the booking's weight tier has no upper bound (the
  // store's last tier) and the order has no recorded weight.
  defaultWeightGrams: Joi.number().integer().min(1).max(100000).optional(),
});

/**
 * The weight declared to Mylerz for a booking. Mylerz has no package types,
 * only Total_Weight; the tier's upper bound is declared so the parcel is
 * never under-declared. An open last tier (or no tier) falls back to the
 * order's own weight in createShipment, then to defaultWeightGrams.
 *
 * @returns {{ weightGrams: number|null, tierId: string|null, source: 'tier'|'default' }}
 */
function resolvePackage(carrierSettings = {}, tier = null) {
  if (tier && tier.upToGrams != null) return { weightGrams: tier.upToGrams, tierId: tier.id, source: 'tier' };
  return { weightGrams: carrierSettings.defaultWeightGrams || null, tierId: tier ? tier.id : null, source: 'default' };
}

/**
 * Logs in (POST /token) and reads GET api/Orders/GetWarehouses — the same
 * check the official plugin makes, and it lists the pickup warehouses.
 */
async function verifyCredentials(creds, settings = {}) {
  // Always a real login: a cached token proves nothing about the password.
  await tokenFor(creds, { fresh: true });
  const data = await call(creds, { path: '/api/Orders/GetWarehouses', retry: true });
  const pickupLocations = (Array.isArray(data) ? data : [])
    .filter((w) => w && w.Name)
    .map((w) => ({ id: String(w.Name), name: String(w.Name) }));
  if (settings.warehouseName && !pickupLocations.some((w) => w.id === settings.warehouseName)) {
    throw new AppError('VALIDATION_ERROR', 'Validation failed', 422, [
      { field: 'settings.warehouseName', message: "Not one of this Mylerz account's warehouses" },
    ]);
  }
  return { pickupLocations };
}

/**
 * GET api/packages/GetCityZoneList: cities, each with its zones — what
 * AddOrders calls the Neighborhood. Mylerz also has sub-zones
 * (GetSubZoneList/{zoneCode}), which no create field takes, so the tree
 * stops at the zone.
 */
async function listAddressTree(creds) {
  const data = await call(creds, { path: '/api/packages/GetCityZoneList', retry: true });
  return (Array.isArray(data) ? data : [])
    .filter((city) => city && city.Code)
    .map((city) => ({
      id: String(city.Code),
      name: city.EnName || null,
      nameAr: city.ArName || null,
      children: (Array.isArray(city.Zones) ? city.Zones : [])
        .filter((zone) => zone && zone.Code)
        .map((zone) => ({ id: String(zone.Code), name: zone.EnName || null, nameAr: zone.ArName || null })),
    }));
}

/**
 * The address fields of an OrderDTO for a matched path [city, zone]. The
 * official plugin sends the zone code as Neighborhood, Country "Egypt" and
 * the whole street text in Street, and no City — this does the same
 * (whether City would help routing: UNVERIFIED 7).
 */
function toCarrierAddress(address) {
  const zone = address.path[address.path.length - 1];
  const street = String(address.firstLine || '').trim();
  if (!street) {
    throw new AppError('VALIDATION_ERROR', 'Validation failed', 422, [
      { field: 'shippingAddress.addressLine', message: 'Mylerz needs a street address' },
    ]);
  }
  return { Country: 'Egypt', Neighborhood: zone.id, Street: cut(street, LIMITS.street) };
}

/** POST api/Orders/AddOrders with one OrderDTO. Never retried. */
async function createShipment(creds, input) {
  const { order, address, cod, goodsValue, description, notes, carrierSettings = {} } = input;
  const pkg = input.package || resolvePackage(carrierSettings, null);

  if (order.currency !== 'EGP') {
    throw new AppError('CARRIER_CURRENCY_UNSUPPORTED', 'Mylerz (Egypt) only collects cash in EGP; this order is in another currency', 422);
  }
  const codEgp = toEgp(cod, 'cod');
  const goodsEgp = toEgp(goodsValue, 'goodsValue');
  // No COD ceiling is documented (UNVERIFIED 8); ValueOfGoods' range is.
  if (goodsEgp > MAX_GOODS_VALUE_EGP) {
    throw new AppError('CARRIER_GOODS_VALUE_LIMIT', `Mylerz accepts a declared goods value of at most ${MAX_GOODS_VALUE_EGP} EGP`, 422);
  }

  const contact = order.contactSnapshot || {};
  const weightGrams = pkg.weightGrams || order.totalWeightGrams || null;
  const body = [
    {
      Package_Serial: 1,
      Reference: cut(order.orderNumber, LIMITS.reference),
      Description: String(description || '').slice(0, 500) || 'Order',
      Service_Type: carrierSettings.serviceType || 'DTD',
      Service: carrierSettings.service || 'ND',
      Service_Category: 'DELIVERY',
      Payment_Type: codEgp > 0 ? 'COD' : 'PP',
      // COD_Value is a string in the schema; the plugin sends a 2-dp number.
      COD_Value: codEgp > 0 ? codEgp.toFixed(2) : '0',
      ValueOfGoods: goodsEgp,
      Currency: 'EGP',
      // Total_Weight's unit is not documented; kilograms (UNVERIFIED 9).
      ...(weightGrams ? { Total_Weight: Math.round(weightGrams) / 1000 } : {}),
      Pieces: [{ PieceNo: 1 }],
      Customer_Name: cut(String(contact.fullName || '').trim() || 'Customer', LIMITS.name),
      Mobile_No: localPhone(contact.phone, 'contact.phone'),
      ...(contact.alternatePhone ? { Mobile_No2: localPhone(contact.alternatePhone, 'contact.alternatePhone') } : {}),
      ...(contact.email ? { Customer_Email: cut(contact.email, LIMITS.email) } : {}),
      ...toCarrierAddress(address),
      ...(notes || address.secondLine ? { Special_Notes: cut([notes, address.secondLine].filter(Boolean).join(' — '), LIMITS.notes) } : {}),
      ...(carrierSettings.warehouseName ? { WarehouseName: carrierSettings.warehouseName } : {}),
      // The plugin's value for a home address (lookup GetAllAddressCategory).
      Address_Category: 'H',
    },
  ];

  const value = await call(creds, {
    method: 'POST',
    path: '/api/Orders/AddOrders',
    body,
    action: 'create',
    timeoutMs: carrierHttp.CREATE_TIMEOUT_MS,
  });
  const packages = value && Array.isArray(value.Packages) ? value.Packages : [];
  const created = packages[0];
  const refusal = (created && created.ErrorMessage) || (value && value.ErrorMessage);
  if (!created || !created.BarCode) {
    const message = sanitizeCarrierMessage(refusal, secretsOf(creds));
    throw new CarrierError(message ? `Mylerz: ${message}` : 'Mylerz accepted the order but returned no barcode');
  }
  return {
    trackingNumber: String(created.BarCode),
    carrierShipmentId: value.PickupOrderCode || null,
    // GetTrackShipmentUrl takes no parameters and its meaning is not
    // documented, so no per-package tracking link.
    trackingUrl: null,
    labelUrl: null,
    raw: { ...pickPackage(created), pickupOrderCode: value.PickupOrderCode || null },
  };
}

/**
 * POST api/packages/GetPackageListStatus with the barcodes. A row carrying
 * an ErrorMessage, or no row at all, is an unanswered barcode.
 */
async function getShipments(creds, trackingNumbers) {
  const refs = trackingNumbers.map(String);
  const data = await call(creds, { method: 'POST', path: '/api/packages/GetPackageListStatus', body: refs, retry: true });
  const out = new Map();
  for (const row of Array.isArray(data) ? data : []) {
    if (!row || row.BarCode == null || row.ErrorMessage) continue;
    const ref = String(row.BarCode);
    if (refs.includes(ref)) out.set(ref, resultFrom(row));
  }
  return out;
}

/** One barcode, through the bulk call (GetPackageStatus has no schema page). */
async function getShipment(creds, trackingNumber) {
  const result = (await getShipments(creds, [trackingNumber])).get(String(trackingNumber));
  if (!result) throw new CarrierError(`Mylerz has no package ${trackingNumber} for this account`);
  return result;
}

/** POST api/packages/CancelPackage for one barcode. */
async function cancelShipment(creds, trackingNumber) {
  const data = await call(creds, {
    method: 'POST',
    path: '/api/packages/CancelPackage',
    body: [{ Barcode: String(trackingNumber) }],
  });
  const row = (Array.isArray(data) ? data : []).find((r) => r && String(r.Barcode) === String(trackingNumber));
  if (!row || row.IsChanged !== true) {
    const message = sanitizeCarrierMessage(row && row.ErrorMessage, secretsOf(creds));
    throw new CarrierError(message ? `Mylerz: ${message}` : 'Mylerz did not cancel the package');
  }
}

function isCancelSettled(carrierStatus) {
  const value = carrierStatus ? carrierStatus.value : null;
  return value != null && CANCEL_SETTLED_STATES.includes(value);
}

/**
 * POST api/packages/GetAWB: `Value` is a byte[] (base64 in JSON). The schema
 * does not say it is a PDF (UNVERIFIED 10), so it must start with %PDF.
 */
async function getLabel(creds, trackingNumber) {
  const data = await call(creds, { method: 'POST', path: '/api/packages/GetAWB', body: { Barcode: String(trackingNumber) }, retry: true });
  const pdf = typeof data === 'string' ? Buffer.from(data, 'base64') : null;
  if (!pdf || pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new CarrierError('Mylerz did not return a printable label for this shipment');
  }
  return pdf;
}

module.exports = defineAdapter({
  code: 'mylerz',
  name: 'Mylerz',
  nameAliases: ['مايلرز'],
  capabilities: {
    cancel: 'api',
    label: true,
    // Mylerz documents no webhooks: the carrier-sync cron polls.
    webhook: 'none',
    polling: true,
    bulkStatus: true,
    addressLevels: ['city', 'neighborhood'],
    reserveNameWhenUnconnected: false,
  },
  pollIntervalMinutes: 60,
  credentialFields: [
    { key: 'username', label: 'Mylerz username', secret: false },
    { key: 'password', label: 'Mylerz password', secret: true },
  ],
  settingFields: [
    { key: 'warehouseName', label: 'Pickup warehouse' },
    { key: 'serviceType', label: 'Service type', options: SERVICE_TYPES },
    { key: 'service', label: 'Service', options: SERVICES },
    { key: 'defaultWeightGrams', label: 'Default weight (grams)' },
  ],
  credentialsSchema,
  settingsSchema,
  verifyCredentials,
  resolvePackage,
  listAddressTree,
  toCarrierAddress,
  createShipment,
  getShipment,
  getShipments,
  cancelShipment,
  isCancelSettled,
  getLabel,
  // Exposed for tests and the docs.
  STATE_MAP,
  CANCEL_SETTLED_STATES,
  mapStatus,
  clearTokens,
  BARCODE,
  BASE_URL,
});
