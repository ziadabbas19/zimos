'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const carrierHttp = require('./carrierHttp');
const { CarrierAuthError, CarrierError, sanitizeCarrierMessage } = require('./carrierErrors');
const { AppError } = require('../../../core/errors/AppError');
const { assertInt } = require('../../../core/utils/money');
const { normalizePhone } = require('../../../core/utils/phone');
const logger = require('../../../core/utils/logger');
const { defineAdapter } = require('./adapterContract');

/**
 * J&T Express Egypt adapter, on J&T's JMS open platform. Sources, fetched
 * 2026-09-26 — nothing else:
 *
 *   Open platform   https://open.jtjms-eg.com  (API documentation is public;
 *                   the pages are a Vue app whose content ships in its JS)
 *     #/apiDoc/index                 docking process, credentials, signatures
 *     #/apiDoc/orderserve/create     order/addOrder
 *     #/apiDoc/orderserve/cancel     order/cancelOrder
 *     #/apiDoc/orderserve/query      order/getOrders
 *     #/apiDoc/logistics/query       logistics/trace
 *     #/apiDoc/other/...             order/printOrder, vip/checkCusPwd,
 *                                    location/getLocation
 *   Official samples https://download.jtjms-eg.com/open/PHP%2Bsignature%2Bexample.zip
 *                   (the digest algorithms) and the per-language samples on
 *                   the platform's SDK page (request shape, Egyptian payload)
 *
 * Every call: POST <base>/<path>, form field `bizContent` (a JSON string),
 * headers apiAccount, timestamp (ms) and
 *   digest = Base64(MD5(bizContent + privateKey))
 * Order-level calls also carry a business digest inside bizContent:
 *   digest = Base64(MD5(UPPER(customerCode + MD5hex(password + "jadada236t2")) + privateKey))
 * Answers are `{ code, msg, data }`, code "1" = success.
 *
 * Things the sources do not settle are marked "UNVERIFIED (n)" below; the
 * numbered list is in docs/carriers/jtexpress.md.
 */

const BASE_URLS = {
  production: 'https://openapi.jtjms-eg.com/webopenplatformapi/api',
  sandbox: 'https://demoopenapi.jtjms-eg.com/webopenplatformapi/api',
};

const NAME = 'J&T Express';
const COUNTRY = 'EGY';
const PASSWORD_SALT = 'jadada236t2';

// Documented general codes (the platform's error table).
const CODE_OK = '1';
const CODE_HEADER_SIGNATURE = '145003030'; // Headers signature verification failed
const CODE_BUSINESS_SIGNATURE = '145003031'; // Business parameter signature verification failed

// addOrder: "Weight, unit kg, range 0.01-30".
const MIN_WEIGHT_KG = 0.01;
const MAX_WEIGHT_KG = 30;
// logistics/trace: "supports querying up to 30 waybills at one time".
const TRACE_BATCH = 30;
// Field lengths from the addOrder table.
const LIMITS = { name: 50, mobile: 11, street: 200, remark: 200, itemName: 30, email: 150, txlogisticId: 50, amount: 12 };

const SERVICE_TYPES = ['01', '02'];
const PAY_TYPES = ['PP_PM', 'PP_CASH'];
const ORDER_TYPES = ['1', '2'];
const GOODS_TYPES = ['ITN1', 'ITN2', 'ITN3', 'ITN5', 'ITN6', 'ITN7', 'ITN8', 'ITN9', 'ITN10', 'ITN11', 'ITN12', 'ITN13', 'ITN14', 'ITN15', 'ITN16'];
const PRINT_SIZES = [0, 1, 2];

/**
 * Scan types -> our Shipment status. The trace table documents scanTypeCode
 * 1-15 (English and Chinese names below); the trace sample answers with
 * English labels instead ("Pickup scan", "Delivery scan", ...) and the
 * Chinese type in problemReason. A scan is looked up by code, then label,
 * then problemReason.
 *
 *   a status string   move the shipment there
 *   null              documented, but its meaning for the parcel's position
 *                     is not clear from the docs: keep the status
 *   (absent)          unknown: keep the status and log a warning
 */
const CODE_MAP = {
  1: 'picked_up', //    express mail collection      快件揽收
  2: 'in_transit', //   warehouse scanning (disabled) 入仓扫描
  3: 'in_transit', //   mail scanning                发件扫描
  4: 'in_transit', //   to Scanning                  到件扫描
  5: 'in_transit', //   Scanning out of warehouse    出仓扫描
  6: 'in_transit', //   Inbound scanning             入库扫描
  7: null, //           Proxy revenue scan           代理点收入扫描 (UNVERIFIED 3)
  8: null, //           Express take out scanning    快件取出扫描 (UNVERIFIED 3)
  9: 'in_transit', //   Outbound scanning            出库扫描
  10: 'delivered', //   Signing for express mail     快件签收
  11: 'failed', //      Scanning for problems        问题件扫描
  12: 'failed', //      Warehousing of stored parts  留仓件入仓 (UNVERIFIED 3)
  13: 'returned', //    Return signature             退件签收
  14: 'failed', //      Return Scan                  退件扫描
  15: 'in_transit', //  Forward Scan                 转寄扫描
};

const CODE_LABELS = {
  1: ['express mail collection', 'pickup scan', '快件揽收'],
  2: ['warehouse scanning (disabled)', 'warehouse scanning', '入仓扫描'],
  3: ['mail scanning', 'sending scan', '发件扫描'],
  4: ['to scanning', 'station arrival', '到件扫描'],
  5: ['scanning out of warehouse', '出仓扫描'],
  6: ['inbound scanning', '入库扫描'],
  7: ['proxy revenue scan', '代理点收入扫描'],
  8: ['express take out scanning', '快件取出扫描'],
  9: ['outbound scanning', '出库扫描'],
  10: ['signing for express mail', 'signing scan', '快件签收'],
  11: ['scanning for problems', '问题件扫描'],
  12: ['warehousing of stored parts', '留仓件入仓'],
  13: ['return signature', '退件签收'],
  14: ['return scan', '退件扫描'],
  15: ['forward scan', '转寄扫描'],
};

// In the trace sample only, not in the numbered table: the parcel is out
// with the courier for delivery (UNVERIFIED 4).
const EXTRA_LABELS = { 'delivery scan': 'out_for_delivery', 派件扫描: 'out_for_delivery' };

const LABEL_MAP = Object.entries(CODE_LABELS).reduce(
  (map, [code, labels]) => {
    for (const label of labels) map[label] = CODE_MAP[code];
    return map;
  },
  { ...EXTRA_LABELS }
);

// A cancel has nothing left to stop once the parcel is back with the merchant.
const CANCEL_SETTLED_CODES = [13];

// --- signing ------------------------------------------------------------------------

const md5 = (text) => crypto.createHash('md5').update(text, 'utf8');

/** Headers digest: Base64(MD5(bizContent + privateKey)). */
function headerDigest(bizContent, privateKey) {
  return md5(bizContent + privateKey).digest('base64');
}

/** Business digest: Base64(MD5(UPPER(customerCode + MD5hex(password + salt)) + privateKey)). */
function businessDigest(creds) {
  const cipher = md5(creds.password + PASSWORD_SALT).digest('hex');
  return md5(`${creds.customerCode}${cipher}`.toUpperCase() + creds.privateKey).digest('base64');
}

// --- request plumbing ---------------------------------------------------------------

const secretsOf = (creds) => [creds && creds.privateKey, creds && creds.password];

// The environment travels with the credentials: every call gets those,
// while listAddressTree / getShipment / cancelShipment get no settings.
function baseUrl(creds) {
  return BASE_URLS[creds.environment] || BASE_URLS.production;
}

function failFrom(res, creds) {
  const body = res.json || {};
  const code = body.code != null ? String(body.code) : null;
  if (code === CODE_HEADER_SIGNATURE) return new CarrierAuthError(NAME, 'the API account or private key');
  if (code === CODE_BUSINESS_SIGNATURE) return new CarrierAuthError(NAME, 'the customer code or password');
  const message = sanitizeCarrierMessage(body.msg, secretsOf(creds));
  return new CarrierError(message ? `${NAME}: ${message}` : `${NAME} returned HTTP ${res.status}`, {
    carrierErrorCode: code,
    httpStatus: res.status,
  });
}

/**
 * One signed call. `business` adds customerCode + business digest to the
 * payload (the order-level endpoints).
 */
async function call(creds, { path, payload, business = false, retry = false, action, timeoutMs }) {
  const biz = business ? { customerCode: creds.customerCode, digest: businessDigest(creds), ...payload } : payload;
  const bizContent = JSON.stringify(biz);
  let res;
  try {
    res = await carrierHttp.request({
      method: 'POST',
      url: `${baseUrl(creds)}/${path}`,
      headers: {
        apiAccount: String(creds.apiAccount),
        digest: headerDigest(bizContent, creds.privateKey),
        timestamp: String(Date.now()),
      },
      form: { bizContent },
      retry,
      timeoutMs,
    });
  } catch (err) {
    if (action === 'create') {
      throw new CarrierError(
        `${NAME} did not respond (${err.message || 'network error'}). The order may still have been created — ` +
          'check your J&T dashboard before booking this order again.'
      );
    }
    throw new CarrierError(`${NAME} did not respond (${err.message || 'network error'})`);
  }
  // getLocation's sample answers code "10" with msg "success"; every other
  // sample answers "1" (UNVERIFIED 5).
  const ok = res.ok && res.json && (String(res.json.code) === CODE_OK || (res.json.msg === 'success' && res.json.data != null));
  if (!ok) throw failFrom(res, creds);
  return res.json.data;
}

// --- mapping helpers ----------------------------------------------------------------

function toEgp(minor, field) {
  return assertInt(minor, field) / 100;
}

const cut = (value, max) => (value == null ? value : String(value).slice(0, max));
const invalid = (field, message) => new AppError('VALIDATION_ERROR', 'Validation failed', 422, [{ field, message }]);

/**
 * Mobile numbers are documented as String(11): an Egyptian mobile in local
 * form (01XXXXXXXXX). Anything else can't fit and is refused before J&T is
 * called (a sample shows "+01111400750" — UNVERIFIED 13).
 */
function localMobile(raw, field) {
  const digits = normalizePhone(raw);
  const local = digits && digits.startsWith('20') && digits.length === 12 ? `0${digits.slice(2)}` : null;
  if (!local || local.length !== LIMITS.mobile) {
    throw invalid(field, `${NAME} needs an Egyptian mobile number (01XXXXXXXXX)`);
  }
  return local;
}

/** "yyyy-MM-dd HH:mm:ss" in Cairo time (UNVERIFIED 6). */
function cairoTime(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const labelKey = (text) => String(text || '').trim().toLowerCase();

/** { status } for one trace detail; undefined status = unknown. */
function mapStatus(detail) {
  if (!detail) return { status: undefined };
  const code = Number(detail.scanTypeCode);
  if (Number.isInteger(code) && Object.prototype.hasOwnProperty.call(CODE_MAP, code)) return { status: CODE_MAP[code] };
  for (const label of [detail.scanType, detail.problemReason]) {
    const key = labelKey(label);
    if (key && Object.prototype.hasOwnProperty.call(LABEL_MAP, key)) return { status: LABEL_MAP[key] };
  }
  return { status: undefined };
}

/**
 * The newest scan: scanTime is "yyyy-MM-dd HH:mm:ss", so it sorts as text.
 * The order of `details` is not documented (UNVERIFIED 11).
 */
function latestDetail(details) {
  const list = Array.isArray(details) ? details.filter(Boolean) : [];
  return list.reduce((latest, d) => (!latest || String(d.scanTime || '') > String(latest.scanTime || '') ? d : latest), null);
}

// What we keep of a trace: no descriptions (they carry courier phone
// numbers), staff names, contacts or pictures.
function pickScan(billCode, detail) {
  return {
    billCode: String(billCode),
    scanType: detail ? detail.scanType || null : null,
    scanTypeCode: detail && detail.scanTypeCode != null ? String(detail.scanTypeCode) : null,
    scanTime: detail ? detail.scanTime || null : null,
    scanNetworkName: detail ? detail.scanNetworkName || null : null,
  };
}

function resultFrom(row) {
  const detail = latestDetail(row.details);
  const { status } = detail ? mapStatus(detail) : { status: null };
  if (status === undefined) {
    logger.warn('Unmapped J&T scan type — shipment status left unchanged', {
      trackingNumber: String(row.billCode),
      scanType: detail.scanType,
      scanTypeCode: detail.scanTypeCode,
    });
  }
  const raw = pickScan(row.billCode, detail);
  return {
    status: status || null,
    carrierStatus: {
      code: raw.scanTypeCode || raw.scanType || null,
      value: raw.scanType,
      time: raw.scanTime,
    },
    raw,
  };
}

// --- the adapter ----------------------------------------------------------------------

const credentialsSchema = Joi.object({
  apiAccount: Joi.string().trim().pattern(/^\d{1,30}$/).required(),
  privateKey: Joi.string().trim().min(8).max(200).required(),
  customerCode: Joi.string().trim().max(30).required(),
  password: Joi.string().min(1).max(100).required(),
  // J&T's sandbox (demoopenapi) takes its own published test credentials.
  // Only test stores may use it (isSandbox).
  environment: Joi.string().valid('production', 'sandbox').optional(),
});

const SENDER_KEYS = ['senderName', 'senderMobile', 'senderProv', 'senderCity', 'senderArea', 'senderStreet'];

const settingsSchema = Joi.object({
  // The pickup (sender) address, in J&T's own province/city/area names —
  // checked against location/getLocation on connect. Needed to book.
  senderName: Joi.string().trim().max(LIMITS.name).optional(),
  senderMobile: Joi.string().trim().max(30).optional(),
  senderProv: Joi.string().trim().max(60).optional(),
  senderCity: Joi.string().trim().max(60).optional(),
  senderArea: Joi.string().trim().max(60).optional(),
  senderStreet: Joi.string().trim().max(LIMITS.street).optional(),
  // 01 / 02 per the platform's error table; their meanings are not
  // documented (UNVERIFIED 7).
  serviceType: Joi.string().valid(...SERVICE_TYPES).optional(),
  payType: Joi.string().valid(...PAY_TYPES).optional(),
  // 1 individual, 2 contract customer (cancelOrder's table).
  orderType: Joi.string().valid(...ORDER_TYPES).optional(),
  goodsType: Joi.string().valid(...GOODS_TYPES).optional(),
  printSize: Joi.number().valid(...PRINT_SIZES).optional(),
  // Declared weight when neither the tier nor the order has one.
  defaultWeightGrams: Joi.number().integer().min(10).max(MAX_WEIGHT_KG * 1000).optional(),
});

/**
 * The weight to declare: the booking tier's upper bound, so the parcel is
 * never under-declared. An open last tier (or no tier) falls back to the
 * order's weight in createShipment, then defaultWeightGrams.
 */
function resolvePackage(carrierSettings = {}, tier = null) {
  if (tier && tier.upToGrams != null) return { weightGrams: tier.upToGrams, tierId: tier.id, source: 'tier' };
  return { weightGrams: carrierSettings.defaultWeightGrams || null, tierId: tier ? tier.id : null, source: 'default' };
}

/**
 * location/getLocation for Egypt: flat rows of province/city/area with their
 * codes (the doc calls `data` an Object; its sample is a list — UNVERIFIED 5),
 * grouped into governorate > city > area. Names are J&T's own (Arabic in the
 * samples), and those names are what addOrder takes.
 */
// Whether every merchant account may call getLocation: UNVERIFIED 2.
async function listAddressTree(creds) {
  const data = await call(creds, { path: 'location/getLocation', payload: { countryCode: COUNTRY }, retry: true });
  const rows = Array.isArray(data) ? data : [];
  const arabic = (s) => (/[؀-ۿ]/.test(String(s || '')) ? s : null);
  const node = (id, name) => ({ id: String(id), name, nameAr: arabic(name), children: [] });
  const provs = new Map();
  for (const r of rows) {
    if (!r || !r.provCode || !r.cityCode || !r.areaCode || !r.prov || !r.city || !r.area) continue;
    if (!provs.has(r.provCode)) provs.set(r.provCode, { ...node(r.provCode, r.prov), cities: new Map() });
    const prov = provs.get(r.provCode);
    if (!prov.cities.has(r.cityCode)) prov.cities.set(r.cityCode, node(r.cityCode, r.city));
    const city = prov.cities.get(r.cityCode);
    if (!city.children.some((a) => a.id === String(r.areaCode))) {
      const area = node(r.areaCode, r.area);
      delete area.children;
      city.children.push(area);
    }
  }
  return [...provs.values()].map(({ cities, ...prov }) => ({ ...prov, children: [...cities.values()] }));
}

/** Whether the settings name a province > city > area J&T knows. */
function senderInTree(tree, settings) {
  const prov = tree.find((p) => p.name === settings.senderProv);
  const city = prov && prov.children.find((c) => c.name === settings.senderCity);
  return Boolean(city && city.children.some((a) => a.name === settings.senderArea));
}

/**
 * vip/checkCusPwd ("check whether the e-waybill account exists and its
 * information is correct") — read-only, and it exercises both digests. A
 * sender address in the settings must be complete and one J&T knows.
 */
async function verifyCredentials(creds, settings = {}) {
  await call(creds, { path: 'vip/checkCusPwd', payload: {}, business: true, retry: true });

  const given = SENDER_KEYS.filter((k) => settings[k]);
  if (given.length > 0) {
    const missing = SENDER_KEYS.filter((k) => !settings[k]);
    if (missing.length > 0) {
      throw new AppError('VALIDATION_ERROR', 'Validation failed', 422, missing.map((k) => ({ field: `settings.${k}`, message: 'Required with the rest of the pickup address' })));
    }
    localMobile(settings.senderMobile, 'settings.senderMobile');
    const tree = await listAddressTree(creds);
    if (!senderInTree(tree, settings)) {
      throw invalid('settings.senderArea', `Not a province > city > area in ${NAME}'s location list`);
    }
  }
  return {};
}

/** addOrder's receiver address fields from a matched [governorate, city, area] path. */
function toCarrierAddress(address) {
  const [prov, city, area] = address.path;
  const street = String(address.firstLine || '').trim();
  if (!street) throw invalid('shippingAddress.addressLine', `${NAME} needs a street address`);
  return { countryCode: COUNTRY, prov: prov.name, city: city.name, area: area.name, street: cut(street, LIMITS.street) };
}

function senderFrom(settings) {
  const missing = SENDER_KEYS.filter((k) => !settings[k]);
  if (missing.length > 0) {
    throw new AppError(
      'CARRIER_SETTINGS_INCOMPLETE',
      `${NAME} needs the pickup address. Add it in the J&T connection settings.`,
      422,
      missing.map((k) => ({ field: `settings.${k}`, message: 'Required to book with J&T' }))
    );
  }
  return {
    name: cut(settings.senderName, LIMITS.name),
    mobile: localMobile(settings.senderMobile, 'settings.senderMobile'),
    countryCode: COUNTRY,
    prov: settings.senderProv,
    city: settings.senderCity,
    area: settings.senderArea,
    street: cut(settings.senderStreet, LIMITS.street),
  };
}

function weightKg(pkg, order) {
  const candidates = [pkg.weightGrams, order.totalWeightGrams].filter((g) => Number.isFinite(Number(g)) && Number(g) > 0);
  // The tier bound first; when it is over J&T's 30 kg the order's own weight
  // may still fit.
  const grams = candidates.find((g) => Number(g) / 1000 <= MAX_WEIGHT_KG) ?? candidates[0];
  if (grams == null) {
    throw new AppError('CARRIER_WEIGHT_REQUIRED', `${NAME} needs the parcel weight. Set a default weight in the J&T settings or weights on the products.`, 422);
  }
  const kg = Math.max(MIN_WEIGHT_KG, Math.round(Number(grams) / 10) / 100);
  if (kg > MAX_WEIGHT_KG) {
    throw new AppError('CARRIER_WEIGHT_LIMIT', `${NAME} carries parcels of at most ${MAX_WEIGHT_KG} kg`, 422);
  }
  return kg;
}

/**
 * order/addOrder. Never retried. txlogisticId is the order number plus a
 * booking suffix: J&T refuses a reused one ("Customer order number already
 * exists"), and an order can be booked again after a cancel.
 */
async function createShipment(creds, input) {
  const { order, address, cod, goodsValue, description, notes, carrierSettings = {} } = input;
  const pkg = input.package || resolvePackage(carrierSettings, null);

  if (order.currency !== 'EGP') {
    throw new AppError('CARRIER_CURRENCY_UNSUPPORTED', `${NAME} (Egypt) only collects cash in EGP; this order is in another currency`, 422);
  }
  const codEgp = toEgp(cod, 'cod');
  const goodsEgp = toEgp(goodsValue, 'goodsValue');
  // itemsValue is String(12); no ceiling is documented beyond that (UNVERIFIED 8).
  if (codEgp.toFixed(2).length > LIMITS.amount) {
    throw new AppError('CARRIER_COD_LIMIT', `${NAME} can't collect an amount this large`, 422);
  }

  const contact = order.contactSnapshot || {};
  const sender = senderFrom(carrierSettings);
  const receiver = {
    name: cut(String(contact.fullName || '').trim() || 'Customer', LIMITS.name),
    mobile: localMobile(contact.phone, 'contact.phone'),
    ...(contact.alternatePhone ? { phone: localMobile(contact.alternatePhone, 'contact.alternatePhone') } : {}),
    ...(contact.email ? { mailBox: cut(contact.email, LIMITS.email) } : {}),
    ...toCarrierAddress(address),
  };
  const now = new Date();
  const txlogisticId = cut(`${order.orderNumber}-${now.getTime().toString(36).toUpperCase()}`, LIMITS.txlogisticId);
  const itemName = cut(String(description || '').replace(/^\d+x\s*/, '') || 'Order', LIMITS.itemName);

  const payload = {
    txlogisticId,
    expressType: 'EZ', // "only supports EZ"
    // addOrder's table does not list orderType; the cancel table's "2"
    // (contract customer) is the default (UNVERIFIED 1).
    orderType: carrierSettings.orderType || '2',
    serviceType: carrierSettings.serviceType || '01',
    deliveryType: '04', // home delivery
    payType: carrierSettings.payType || 'PP_PM',
    goodsType: carrierSettings.goodsType || 'ITN16',
    operateType: 1, // add
    sender,
    receiver,
    sendStartTime: cairoTime(now),
    sendEndTime: cairoTime(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
    weight: weightKg(pkg, order),
    totalQuantity: 1, // "must be 1"
    ...(codEgp > 0 ? { itemsValue: codEgp.toFixed(2), priceCurrency: 'EGP' } : {}),
    items: [
      {
        itemType: carrierSettings.goodsType || 'ITN16',
        itemName,
        number: 1,
        itemValue: goodsEgp.toFixed(2),
        priceCurrency: 'EGP',
        desc: cut(description, 200),
      },
    ],
    ...(notes || address.secondLine ? { remark: cut([notes, address.secondLine].filter(Boolean).join(' — '), LIMITS.remark) } : {}),
  };

  const data = await call(creds, {
    path: 'order/addOrder',
    payload,
    business: true,
    action: 'create',
    timeoutMs: carrierHttp.CREATE_TIMEOUT_MS,
  });
  if (!data || !data.billCode) throw new CarrierError(`${NAME} accepted the order but returned no waybill number`);
  return {
    trackingNumber: String(data.billCode),
    // cancelOrder takes this, not the waybill number.
    carrierShipmentId: String(data.txlogisticId || txlogisticId),
    trackingUrl: null,
    labelUrl: null,
    raw: {
      billCode: String(data.billCode),
      txlogisticId: String(data.txlogisticId || txlogisticId),
      sortingCode: data.sortingCode || null,
      lastCenterName: data.lastCenterName || null,
    },
  };
}

/** logistics/trace, 30 waybills per call. */
async function getShipments(creds, trackingNumbers) {
  const refs = trackingNumbers.map(String);
  const out = new Map();
  for (let i = 0; i < refs.length; i += TRACE_BATCH) {
    const chunk = refs.slice(i, i + TRACE_BATCH);
    // eslint-disable-next-line no-await-in-loop
    const data = await call(creds, { path: 'logistics/trace', payload: { billCodes: chunk.join(',') }, retry: true });
    for (const row of Array.isArray(data) ? data : []) {
      if (row && row.billCode != null && chunk.includes(String(row.billCode))) out.set(String(row.billCode), resultFrom(row));
    }
  }
  return out;
}

async function getShipment(creds, trackingNumber) {
  const result = (await getShipments(creds, [trackingNumber])).get(String(trackingNumber));
  if (!result) throw new CarrierError(`${NAME} has no waybill ${trackingNumber}`);
  return result;
}

/**
 * order/cancelOrder, by the txlogisticId we booked with. Which states can be
 * cancelled is not documented (UNVERIFIED 9).
 */
async function cancelShipment(creds, trackingNumber, { carrierShipmentId } = {}) {
  if (!carrierShipmentId) {
    throw new CarrierError(`${NAME} cancels by the order reference, and shipment ${trackingNumber} has none recorded`);
  }
  await call(creds, {
    path: 'order/cancelOrder',
    // Contract customer, as booked by default (UNVERIFIED 1).
    payload: { orderType: '2', txlogisticId: carrierShipmentId, reason: 'Cancelled by the merchant' },
    business: true,
  });
}

/** J&T's sandbox ships nothing: see carriers/index.js assertSandboxAllowed. */
function isSandbox(creds) {
  return Boolean(creds && creds.environment === 'sandbox');
}

function isCancelSettled(carrierStatus) {
  if (!carrierStatus) return false;
  const code = Number(carrierStatus.code);
  if (CANCEL_SETTLED_CODES.includes(code)) return true;
  return LABEL_MAP[labelKey(carrierStatus.value)] === 'returned';
}

/** order/printOrder: data.base64EncodeContent is the PDF. */
async function getLabel(creds, trackingNumber, carrierSettings = {}) {
  const data = await call(creds, {
    path: 'order/printOrder',
    payload: {
      billCode: String(trackingNumber),
      printSize: carrierSettings.printSize != null ? carrierSettings.printSize : 0,
      printCod: 1,
      showCustomerOrderId: 0,
    },
    business: true,
    retry: true,
  });
  const encoded = data && typeof data.base64EncodeContent === 'string' ? data.base64EncodeContent : null;
  const pdf = encoded ? Buffer.from(encoded, 'base64') : null;
  if (!pdf || pdf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new CarrierError(`${NAME} did not return a printable label for this shipment`);
  }
  return pdf;
}

module.exports = defineAdapter({
  code: 'jtexpress',
  name: NAME,
  nameAliases: ['J&T', 'JT Express', 'J and T', 'جي اند تي', 'جي آند تي'],
  capabilities: {
    cancel: 'api',
    label: true,
    // J&T documents a track push, but it needs the URL handed to J&T outside
    // the API plus a subscription per waybill, and the push signature is not
    // spelled out (UNVERIFIED 10): the carrier-sync cron polls instead.
    webhook: 'none',
    polling: true,
    bulkStatus: true,
    addressLevels: ['governorate', 'city', 'area'],
    reserveNameWhenUnconnected: false,
  },
  pollIntervalMinutes: 60,
  credentialFields: [
    { key: 'apiAccount', label: 'API account', secret: false },
    { key: 'privateKey', label: 'Private key', secret: true },
    { key: 'customerCode', label: 'Customer code', secret: false },
    { key: 'password', label: 'Customer password', secret: true },
    { key: 'environment', label: 'Environment', secret: false, options: ['production', 'sandbox'] },
  ],
  settingFields: [
    { key: 'senderName', label: 'Pickup contact name' },
    { key: 'senderMobile', label: 'Pickup mobile' },
    { key: 'senderProv', label: 'Pickup governorate (J&T name)' },
    { key: 'senderCity', label: 'Pickup city (J&T name)' },
    { key: 'senderArea', label: 'Pickup area (J&T name)' },
    { key: 'senderStreet', label: 'Pickup street address' },
    { key: 'serviceType', label: 'Service type', options: SERVICE_TYPES },
    { key: 'payType', label: 'Freight payment', options: PAY_TYPES },
    { key: 'orderType', label: 'Customer type', options: ORDER_TYPES },
    { key: 'goodsType', label: 'Goods type', options: GOODS_TYPES },
    { key: 'printSize', label: 'Label size', options: PRINT_SIZES },
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
  isSandbox,
  getLabel,
  // Exposed for tests and the docs.
  CODE_MAP,
  STATE_MAP: CODE_MAP,
  LABEL_MAP,
  mapStatus,
  headerDigest,
  businessDigest,
  BASE_URLS,
});
