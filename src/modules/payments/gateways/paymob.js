'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const env = require('../../../config/env');
const gatewayHttp = require('./gatewayHttp');
const { GatewayAuthError, GatewayRejectedError, GatewayError, sanitizeGatewayMessage } = require('./gatewayErrors');
const { AppError } = require('../../../core/errors/AppError');

/**
 * Paymob (Egypt) adapter: the Intention API + Unified Checkout, cards and
 * mobile wallets. Facts used here, from Paymob's developer docs and API
 * reference (checked 2026-09-25):
 *
 *   Create intention   POST {base}/v1/intention/         Authorization: Token <secret key>
 *                      -> { id, client_secret, intention_order_id, ... }
 *   Unified Checkout   {base}/unifiedcheckout/?publicKey=<public key>&clientSecret=<client_secret>
 *   Refund             POST {base}/api/acceptance/void_refund/refund   Authorization: Token <secret key>
 *                      { transaction_id, amount_cents } -> the refund transaction
 *   Auth token         POST {base}/api/auth/tokens { api_key } -> { token }   (valid ~60 minutes)
 *   Inquiry            POST {base}/api/ecommerce/orders/transaction_inquiry { order_id }
 *                      Authorization: Bearer <token>  -> the order's transaction
 *   One transaction    GET {base}/api/acceptance/transactions/{id}   Authorization: Bearer <token>
 *
 * Callbacks. The "transaction processed callback" is a server-to-server POST
 * `{ type: 'TRANSACTION', obj: {...} }` with `?hmac=` in the query string. The
 * "transaction response callback" is the shopper's browser redirect, a GET
 * whose query string carries the same transaction flattened. Both are signed
 * the same way: HMAC-SHA512 (hex) with the account's HMAC secret over the
 * concatenated values of these 20 fields, in this order —
 *
 *   amount_cents, created_at, currency, error_occured, has_parent_transaction,
 *   id, integration_id, is_3d_secure, is_auth, is_capture, is_refunded,
 *   is_standalone_payment, is_voided, order.id, owner, pending,
 *   source_data.pan, source_data.sub_type, source_data.type, success
 *
 * — nested keys in the POST body (`order.id`, `source_data.pan`), flattened
 * keys on the redirect (`order`, `source_data.pan`; some accounts send
 * `order_id` / `pan` / `sub_type` / `type`, which are accepted too). The
 * signature does NOT cover merchant_order_id / special_reference, so a
 * callback is matched to our attempt by the Paymob order id alone.
 *
 * A refund or a void is its own transaction (is_refund / is_void true, the
 * original in parent_transaction) and arrives as a TRANSACTION callback like
 * a payment — including refunds made in Paymob's own dashboard.
 *
 * Amounts: Paymob takes and reports amount_cents; our BIGINT minor units for
 * EGP are piasters, the same number.
 */

const code = 'paymob';
const name = 'Paymob';

const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

// Where each signed field may sit on the flattened redirect query.
const REDIRECT_ALIASES = {
  'order.id': ['order', 'order.id', 'order_id'],
  'source_data.pan': ['source_data.pan', 'pan'],
  'source_data.sub_type': ['source_data.sub_type', 'sub_type'],
  'source_data.type': ['source_data.type', 'type'],
};

const METHODS = ['card', 'wallet'];
const CURRENCIES = ['EGP'];

const integrationId = Joi.alternatives()
  .try(Joi.number().integer().positive(), Joi.string().pattern(/^\d{1,12}$/))
  .custom((value) => Number(value));

const credentialsSchema = Joi.object({
  secretKey: Joi.string().trim().min(10).max(500).required(),
  publicKey: Joi.string().trim().min(10).max(500).required(),
  apiKey: Joi.string().trim().min(10).max(2000).required(),
  hmacSecret: Joi.string().trim().min(8).max(500).required(),
});

const settingsSchema = Joi.object({
  cardIntegrationId: integrationId.allow(null).optional(),
  walletIntegrationId: integrationId.allow(null).optional(),
});

const bi = (en, ar) => ({ en, ar });

const credentialFields = [
  { key: 'secretKey', secret: true, label: bi('Secret key', 'المفتاح السري (Secret key)'), placeholder: 'egy_sk_test_…' },
  { key: 'publicKey', secret: false, label: bi('Public key', 'المفتاح العام (Public key)'), placeholder: 'egy_pk_test_…' },
  { key: 'apiKey', secret: true, label: bi('API key', 'مفتاح الـ API (API key)') },
  { key: 'hmacSecret', secret: true, label: bi('HMAC secret', 'مفتاح الـ HMAC') },
];

const settingFields = [
  {
    key: 'cardIntegrationId',
    method: 'card',
    type: 'integer',
    label: bi('Card integration ID', 'رقم تكامل الكروت (Integration ID)'),
  },
  {
    key: 'walletIntegrationId',
    method: 'wallet',
    type: 'integer',
    label: bi('Mobile wallet integration ID', 'رقم تكامل المحافظ الإلكترونية (Integration ID)'),
  },
];

const setupSteps = {
  en: [
    'Log in to your Paymob dashboard (accept.paymob.com).',
    'Open Settings → Account info and copy the Secret key, Public key, API key and HMAC secret. Test keys contain "_test_", live keys "_live_" — use the same mode for both keys.',
    'Open Developers → Payment integrations and copy the Integration ID of your card integration and, if you accept mobile wallets, of your wallet integration.',
    'For EACH of those integrations, click Edit and paste the webhook URL shown below into "Transaction processed callback". Leave "Transaction response callback" as it is — we send the shopper back ourselves.',
    'Paste everything here and connect. Start in test mode, place a test order from the store preview, then switch to live keys.',
  ],
  ar: [
    'ادخل على لوحة تحكم Paymob ‏(accept.paymob.com).',
    'من Settings ← Account info انسخ الـ Secret key والـ Public key والـ API key والـ HMAC secret. مفاتيح التجربة فيها "_test_" ومفاتيح التشغيل فيها "_live_" — لازم المفتاحين يكونوا من نفس النوع.',
    'من Developers ← Payment integrations انسخ رقم الـ Integration ID الخاص بالكروت، ولو هتقبل محافظ إلكترونية انسخ رقم تكامل المحافظ كمان.',
    'لكل تكامل منهم اضغط Edit والصق رابط الـ webhook اللي تحت في خانة "Transaction processed callback". سيب "Transaction response callback" زي ما هي — إحنا بنرجّع العميل للمتجر بنفسنا.',
    'الصق كل البيانات هنا واضغط ربط. ابدأ بمفاتيح التجربة، اعمل طلب تجريبي من معاينة المتجر، وبعدها بدّل لمفاتيح التشغيل.',
  ],
};

const helpLinks = [
  { label: bi('Paymob developer docs', 'مستندات Paymob للمطورين'), url: 'https://developers.paymob.com/' },
  {
    label: bi('Webhooks and HMAC', 'الـ Webhooks والـ HMAC'),
    url: 'https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac',
  },
  { label: bi('Paymob dashboard', 'لوحة تحكم Paymob'), url: 'https://accept.paymob.com/portal2/en/login' },
];

const webhookSetup = {
  field: 'Transaction processed callback',
  perIntegration: true,
};

const baseUrl = () => env.payments.paymobBaseUrl;

// ------------------------------------------------------------------ helpers

const secretsOf = (creds) => [creds && creds.secretKey, creds && creds.apiKey, creds && creds.hmacSecret, creds && creds.publicKey];

function asBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

/** JS Array.join semantics: null / undefined become ''; booleans 'true' / 'false'. */
function concatSigned(values) {
  return values.map((v) => (v === null || v === undefined ? '' : String(v))).join('');
}

function hmacHex(secret, text) {
  return crypto.createHmac('sha512', secret).update(text, 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The signed string of a processed-callback `obj`. */
function signedStringFromTransaction(obj) {
  return concatSigned(HMAC_FIELDS.map((field) => getPath(obj, field)));
}

/** The signed string of a redirect query, whichever key spelling it uses. */
function signedStringFromQuery(query) {
  return concatSigned(
    HMAC_FIELDS.map((field) => {
      for (const key of REDIRECT_ALIASES[field] || [field]) {
        if (query[key] !== undefined) return query[key];
      }
      return undefined;
    })
  );
}

function modeOf(key) {
  if (/_test_/i.test(key)) return 'test';
  if (/_live_/i.test(key)) return 'live';
  return null;
}

/** 'test' | 'live', from the two keys. They must agree. */
function modeFromCredentials(creds) {
  const secretMode = modeOf(creds.secretKey);
  const publicMode = modeOf(creds.publicKey);
  if (!secretMode || !publicMode) {
    throw new AppError(
      'GATEWAY_KEYS_UNRECOGNISED',
      'These do not look like Paymob keys: a Paymob secret / public key contains "_test_" or "_live_".',
      422
    );
  }
  if (secretMode !== publicMode) {
    throw new AppError(
      'GATEWAY_KEYS_MODE_MISMATCH',
      'The secret key and the public key are from different modes (one test, one live). Use both from the same mode.',
      422
    );
  }
  return secretMode;
}

function messageFrom(res) {
  const json = res.json || {};
  if (typeof json.detail === 'string') return json.detail;
  if (typeof json.message === 'string') return json.message;
  if (json.data && typeof json.data.message === 'string') return json.data.message;
  if (Array.isArray(json.non_field_errors)) return json.non_field_errors.join(' ');
  const firstField = Object.entries(json).find(([, v]) => Array.isArray(v) && typeof v[0] === 'string');
  if (firstField) return `${firstField[0]}: ${firstField[1][0]}`;
  return res.text ? res.text.slice(0, 200) : `HTTP ${res.status}`;
}

/** A non-2xx response as the error the callers expect. */
function errorFor(res, creds, what) {
  const detail = sanitizeGatewayMessage(messageFrom(res), secretsOf(creds));
  if (res.status === 401 || res.status === 403) return new GatewayAuthError(name);
  if (res.status >= 400 && res.status < 500) return new GatewayRejectedError(`Paymob refused ${what}: ${detail}`);
  return new GatewayError(`Paymob could not ${what} right now (HTTP ${res.status}).`);
}

async function call(creds, opts, what) {
  let res;
  try {
    res = await gatewayHttp.request(opts);
  } catch (err) {
    throw new GatewayError(`Paymob could not be reached to ${what} (${err.message}).`);
  }
  if (!res.ok) throw errorFor(res, creds, what);
  return res;
}

// Auth tokens for the inquiry API, per API key, for 50 of their 60 minutes.
const tokenCache = new Map();
const TOKEN_TTL_MS = 50 * 60 * 1000;

async function authToken(creds) {
  const cacheKey = crypto.createHash('sha256').update(creds.apiKey).digest('hex');
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const res = await call(
    creds,
    { method: 'POST', url: `${baseUrl()}/api/auth/tokens`, body: { api_key: creds.apiKey }, retry: true },
    'sign in with this API key'
  );
  const token = res.json && res.json.token;
  if (!token) throw new GatewayError('Paymob returned no auth token.');
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

function clearTokenCache() {
  tokenCache.clear();
}

/**
 * One Paymob transaction, as our code talks about it.
 *
 *   kind     'payment' | 'refund' | 'void'
 *   status   payment: 'paid' | 'failed' | 'pending'
 *            refund / void: 'processed' | 'failed' | 'pending'
 */
function normalizeTransaction(t) {
  const isRefund = asBool(t.is_refund);
  const isVoid = asBool(t.is_void);
  const kind = isRefund ? 'refund' : isVoid ? 'void' : 'payment';
  const success = asBool(t.success);
  const pending = asBool(t.pending);
  let status;
  if (pending) status = 'pending';
  else if (success) status = kind === 'payment' ? 'paid' : 'processed';
  else status = 'failed';

  // Nested on the processed callback, flat on the redirect and in the stored
  // payload (see storablePayload).
  let orderId = t.order && typeof t.order === 'object' ? t.order.id : t.order;
  if (orderId === undefined) orderId = t['order.id'] !== undefined ? t['order.id'] : t.order_id;
  const source = t.source_data && typeof t.source_data === 'object' ? t.source_data : {};
  const pan = source.pan !== undefined ? source.pan : t['source_data.pan'];
  const subType = source.sub_type !== undefined ? source.sub_type : t['source_data.sub_type'];
  const parent = t.parent_transaction;
  const message = (t.data && typeof t.data === 'object' && t.data.message) || t['data.message'] || t.txn_response_code || null;

  return {
    kind,
    status,
    transactionId: t.id !== undefined && t.id !== null ? String(t.id) : null,
    parentTransactionId: parent !== undefined && parent !== null && parent !== '' ? String(parent) : null,
    providerOrderId: orderId !== undefined && orderId !== null && orderId !== '' ? String(orderId) : null,
    amount: Number(t.amount_cents),
    currency: t.currency ? String(t.currency).toUpperCase() : null,
    maskedDisplay: pan ? `${subType ? `${subType} ` : ''}•••• ${String(pan).slice(-4)}`.slice(0, 100) : null,
    failureReason: status === 'failed' && message ? String(message).slice(0, 300) : null,
    isTest: t.is_live !== undefined ? !asBool(t.is_live) : null,
  };
}

/** What we keep of a transaction in the event inbox: no billing data, no card details beyond the mask. */
function storablePayload(t) {
  const keep = {};
  for (const field of HMAC_FIELDS) {
    const value = getPath(t, field);
    if (value !== undefined && field !== 'source_data.pan') keep[field] = value;
  }
  for (const key of ['is_refund', 'is_void', 'parent_transaction', 'refunded_amount_cents', 'captured_amount', 'txn_response_code']) {
    if (t[key] !== undefined) keep[key] = t[key];
  }
  if (t.data && typeof t.data === 'object' && t.data.message) keep['data.message'] = t.data.message;
  if (t['data.message']) keep['data.message'] = t['data.message'];
  return keep;
}

// ----------------------------------------------------------------- interface

/** Connect: the API key must sign in; the two keys must agree on test / live. */
async function verifyCredentials(creds) {
  const mode = modeFromCredentials(creds);
  await authToken(creds);
  return { mode };
}

/** Which of our methods this account's settings can take. */
function availableMethods(settings = {}) {
  return METHODS.filter((m) => (m === 'card' ? settings.cardIntegrationId : settings.walletIntegrationId));
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: 'NA', last: 'NA' };
  if (parts.length === 1) return { first: parts[0], last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Creates the intention and returns where to send the shopper.
 *
 * @returns {{ providerOrderId: string, providerReference: string, redirectUrl: string }}
 */
async function createPayment(creds, { attempt, order, method, settings, returnUrl, webhookUrl, expiresInSeconds, storeName }) {
  const integration = method === 'card' ? settings.cardIntegrationId : settings.walletIntegrationId;
  if (!integration) {
    throw new AppError('PAYMENT_METHOD_UNAVAILABLE', `This store cannot take ${method} payments right now`, 422);
  }
  const contact = order.contactSnapshot || {};
  const address = order.shippingAddressSnapshot || {};
  const { first, last } = splitName(contact.fullName);
  const email = contact.email || `no-email@${env.platformRootDomain}`;
  const amount = Number(attempt.amount);

  const body = {
    amount,
    currency: attempt.currency,
    payment_methods: [Number(integration)],
    items: [
      {
        name: `Order ${order.orderNumber}`.slice(0, 50),
        amount,
        description: String(storeName || 'Order').slice(0, 255),
        quantity: 1,
      },
    ],
    billing_data: {
      first_name: first,
      last_name: last,
      phone_number: contact.phone || 'NA',
      email,
      apartment: 'NA',
      floor: 'NA',
      street: address.addressLine || 'NA',
      building: 'NA',
      city: address.city || 'NA',
      state: address.province || 'NA',
      country: address.country || 'EG',
      postal_code: address.postalCode || 'NA',
    },
    customer: { first_name: first, last_name: last, email },
    special_reference: attempt.id,
    notification_url: webhookUrl,
    redirection_url: returnUrl,
    expiration: Math.max(60, Math.floor(expiresInSeconds)),
    extras: { order_id: order.id, attempt_id: attempt.id },
  };

  const res = await call(
    creds,
    {
      method: 'POST',
      url: `${baseUrl()}/v1/intention/`,
      headers: { authorization: `Token ${creds.secretKey}` },
      body,
      timeoutMs: gatewayHttp.WRITE_TIMEOUT_MS,
    },
    'start this payment'
  );
  const json = res.json || {};
  const clientSecret = json.client_secret;
  const providerOrderId = json.intention_order_id;
  if (!clientSecret || !providerOrderId) throw new GatewayError('Paymob accepted the payment but returned no checkout details.');

  const query = new URLSearchParams({ publicKey: creds.publicKey, clientSecret });
  return {
    providerOrderId: String(providerOrderId),
    providerReference: json.id ? String(json.id) : null,
    redirectUrl: `${baseUrl()}/unifiedcheckout/?${query.toString()}`,
  };
}

/**
 * What Paymob knows about an attempt, by its Paymob order id.
 *
 * @returns {{ found: false } | { found: true, transaction: object }}  `transaction` normalized
 */
async function inquire(creds, { payment }) {
  if (!payment.providerOrderId) return { found: false };
  const token = await authToken(creds);
  let res;
  try {
    res = await gatewayHttp.request({
      method: 'POST',
      url: `${baseUrl()}/api/ecommerce/orders/transaction_inquiry`,
      headers: { authorization: `Bearer ${token}` },
      body: { order_id: Number(payment.providerOrderId) },
      retry: true,
    });
  } catch (err) {
    throw new GatewayError(`Paymob could not be reached to check this payment (${err.message}).`);
  }
  // No transaction on the order yet: the shopper never submitted a payment.
  if (res.status === 404) return { found: false };
  if (!res.ok) throw errorFor(res, creds, 'check this payment');

  const json = res.json || {};
  const candidates = Array.isArray(json.transactions) ? json.transactions : Array.isArray(json) ? json : [json];
  const payments = candidates.filter((t) => t && t.id !== undefined && !asBool(t.is_refund) && !asBool(t.is_void));
  if (payments.length === 0) return { found: false };
  // A paid transaction wins; otherwise the newest one.
  const paid = payments.find((t) => asBool(t.success) && !asBool(t.pending));
  const chosen = paid || payments[payments.length - 1];
  const transaction = normalizeTransaction(chosen);
  if (!transaction.providerOrderId) transaction.providerOrderId = String(payment.providerOrderId);
  return { found: true, transaction, payload: storablePayload(chosen) };
}

/**
 * One transaction by its Paymob id — how a refund left pending is looked up.
 * Null when Paymob does not know it.
 */
async function inquireTransaction(creds, { transactionId }) {
  const token = await authToken(creds);
  let res;
  try {
    res = await gatewayHttp.request({
      method: 'GET',
      url: `${baseUrl()}/api/acceptance/transactions/${encodeURIComponent(transactionId)}`,
      headers: { authorization: `Bearer ${token}` },
      retry: true,
    });
  } catch (err) {
    throw new GatewayError(`Paymob could not be reached to check this transaction (${err.message}).`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw errorFor(res, creds, 'check this transaction');
  return normalizeTransaction(res.json || {});
}

/**
 * Refunds `amount` of a captured payment.
 *
 * @returns {{ status: 'processed'|'pending'|'failed', providerRefundReference, failureReason }}
 */
async function refund(creds, { payment, amount }) {
  if (!payment.providerTransactionId) {
    throw new GatewayRejectedError('This payment has no Paymob transaction to refund.');
  }
  const res = await call(
    creds,
    {
      method: 'POST',
      url: `${baseUrl()}/api/acceptance/void_refund/refund`,
      headers: { authorization: `Token ${creds.secretKey}` },
      body: { transaction_id: Number(payment.providerTransactionId), amount_cents: Number(amount) },
      timeoutMs: gatewayHttp.WRITE_TIMEOUT_MS,
    },
    'refund this payment'
  );
  const t = normalizeTransaction(res.json || {});
  return {
    status: t.status === 'processed' || t.status === 'pending' ? t.status : 'failed',
    providerRefundReference: t.transactionId,
    failureReason: t.failureReason,
  };
}

/**
 * The processed callback. Returns null for a callback we do not act on (a
 * saved-card TOKEN, a delivery status) — those are acknowledged and dropped.
 * Throws nothing; `valid: false` means the signature did not match.
 *
 * @returns {null | { valid: boolean, eventKey, transaction, payload }}
 */
function parseWebhook({ query, body }, creds) {
  if (!body || body.type !== 'TRANSACTION' || !body.obj || typeof body.obj !== 'object') return null;
  const received = query && typeof query.hmac === 'string' ? query.hmac : '';
  const expected = hmacHex(creds.hmacSecret, signedStringFromTransaction(body.obj));
  return {
    valid: safeEqualHex(expected, received),
    // The same transaction in the same state signs to the same value on both
    // callbacks, so a redirect and a webhook for one payment dedupe together.
    eventKey: `txn:${expected}`,
    transaction: normalizeTransaction(body.obj),
    payload: storablePayload(body.obj),
  };
}

/** The shopper's redirect back to the store, forwarded by the storefront. Same shape as parseWebhook. */
function parseRedirect(query, creds) {
  if (!query || typeof query !== 'object' || query.id === undefined) return null;
  const flat = {};
  for (const [key, value] of Object.entries(query)) flat[key] = Array.isArray(value) ? value[0] : value;
  const expected = hmacHex(creds.hmacSecret, signedStringFromQuery(flat));
  return {
    valid: safeEqualHex(expected, typeof flat.hmac === 'string' ? flat.hmac : ''),
    eventKey: `txn:${expected}`,
    transaction: normalizeTransaction(flat),
    payload: storablePayload(flat),
  };
}

module.exports = {
  code,
  name,
  methods: METHODS,
  currencies: CURRENCIES,
  credentialFields,
  settingFields,
  setupSteps,
  helpLinks,
  webhookSetup,
  credentialsSchema,
  settingsSchema,
  modeFromCredentials,
  availableMethods,
  verifyCredentials,
  createPayment,
  inquire,
  inquireTransaction,
  refund,
  parseWebhook,
  parseRedirect,
  // Exposed for tests.
  HMAC_FIELDS,
  signedStringFromTransaction,
  signedStringFromQuery,
  hmacHex,
  normalizeTransaction,
  clearTokenCache,
};
