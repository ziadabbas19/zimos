'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const env = require('../../../config/env');
const gatewayHttp = require('./gatewayHttp');
const { GatewayAuthError, GatewayRejectedError, GatewayError, sanitizeGatewayMessage } = require('./gatewayErrors');
const { AppError, ValidationError } = require('../../../core/errors/AppError');

/**
 * Kashier (Egypt) adapter: Payment Sessions v3 (the hosted payment page),
 * cards and mobile wallets. Facts used here, from developers.kashier.io and
 * the OpenAPI document it publishes (checked 2026-09-25):
 *
 *   Hosts              test: test-api.kashier.io / test-fep.kashier.io
 *                      live: api.kashier.io / fep.kashier.io
 *                      A test key only works on the test hosts, a live key only
 *                      on the live ones — that is how the mode is detected.
 *   Create session     POST {api}/v3/payment/sessions
 *                      Authorization: <secret key>   api-key: <Payment API key>
 *                      amount is a decimal string ("100.00"); `order` is our
 *                      reference, reported back as merchantOrderId
 *                      -> { _id, sessionUrl, status: 'CREATED', ... }
 *   Session payment    GET {api}/v3/payment/sessions/{id}/payment   (secret key)
 *                      -> { data: { status, amount, currency, merchantOrderId, orderId } }
 *   Orders search      GET {api}/v3/payment/orders?search=<merchantOrderId>   (secret key)
 *                      -> { data: [{ merchantOrderId, orderId, status, transactions[] }] }
 *                      order status CAPTURED is paid
 *   One transaction    GET {api}/v2/aggregator/transactions/{id}   (secret key)
 *   Refund / void      PUT {fep}/v3/orders/{kashierOrderId}   (secret key)
 *                      { apiOperation: 'REFUND', transaction: { amount } }
 *                      { apiOperation: 'VOID', transaction: { amount, targetTransactionId } }
 *                      a refund answers SUCCESS | PENDING | FAILURE and is paid
 *                      from the merchant's AVAILABLE Kashier balance
 *   Entitlement        GET {api}/v2/merchants/{MID}/paymentMethods  (no credential)
 *                      -> { card: true, wallet: true, ... }; unknown MID -> 400/404
 *   Key check          POST {api}/v2/merchants/validate-credentials   (secret key)
 *                      — its response shape is not published; see checkApiKey
 *
 * Webhooks. Sent to the `serverWebhook` passed with each session, as
 * `{ event, data }`; `event` names the operation (pay, refund, partial_refund,
 * void, ...) and is NOT a success signal — data.status (SUCCESS / FAILURE /
 * PENDING) is. Signed in the `x-kashier-signature` header: HMAC-SHA256 (hex)
 * with the Payment API key over the fields named in data.signatureKeys,
 * sorted, as `key=value&...` with only the values URL-encoded (the
 * query-string package's strict encoding). Kashier retries anything but a 200
 * or a 409 ("already processed") for up to 10 attempts.
 *
 * Amounts: Kashier talks in major units (EGP 12.50); ours are BIGINT minor
 * units, so everything crossing the boundary is converted here.
 */

const code = 'kashier';
const name = 'Kashier';

const METHODS = ['card', 'wallet'];
const CURRENCIES = ['EGP', 'USD', 'GBP', 'EUR'];

// The session stops taking payments this long before our attempt expires, so
// a payment can never land after we have already expired the order.
const SESSION_EXPIRY_MARGIN_SECONDS = 120;
const MAX_FAILURE_ATTEMPTS = 3;

// What a signed webhook must cover before we act on it: anything outside
// signatureKeys could have been added or changed by whoever sent it.
const REQUIRED_SIGNED_FIELDS = ['amount', 'currency', 'merchantOrderId', 'status', 'transactionId'];

const INSUFFICIENT_BALANCE = 'REFUND_INSUFFICIENT_GATEWAY_BALANCE';

const credentialsSchema = Joi.object({
  merchantId: Joi.string()
    .trim()
    .pattern(/^MID-\d+-\d+$/)
    .required()
    .messages({ 'string.pattern.base': '"merchantId" looks like MID-123-456' }),
  apiKey: Joi.string().trim().min(10).max(500).required(),
  secretKey: Joi.string().trim().min(10).max(2000).required(),
});

// Filled in by verifyCredentials from what Kashier says the account can take;
// nothing here is typed by the merchant.
const settingsSchema = Joi.object({
  entitledMethods: Joi.array().items(Joi.string().valid(...METHODS)).unique().optional(),
});

const bi = (en, ar) => ({ en, ar });

const credentialFields = [
  { key: 'merchantId', secret: false, label: bi('Merchant ID (MID)', 'رقم التاجر (MID)'), placeholder: 'MID-12345-678' },
  { key: 'apiKey', secret: true, label: bi('Payment API key', 'مفتاح الدفع (Payment API key)') },
  { key: 'secretKey', secret: true, label: bi('Secret key', 'المفتاح السري (Secret key)') },
];

const settingFields = [];

const setupSteps = {
  en: [
    'Log in to your Kashier dashboard (merchant.kashier.io). Your Merchant ID (MID-…) is under your username in the top bar.',
    'Choose the mode with the "It\'s live data" switch in the sidebar: off for test keys, on for live keys. Keys are separate per mode.',
    'Open Integrations (merchant.kashier.io/en/dashboard/integration) and copy the Payment API key and the Secret key of that mode.',
    'Paste the three values here and connect. We detect test or live from the keys and read which methods (card, wallet) your account offers.',
    'Nothing else is needed for payments: we give Kashier the webhook URL with every payment. To also see refunds you make in Kashier\'s own dashboard, add the webhook URL below as a webhook in Kashier (events: refund, partial_refund, void).',
    'If you use Kashier\'s IP allow-list, allow our server\'s address too, or Kashier will refuse our calls.',
    'Start in test mode: place an order from the store preview and pay with a Kashier test card, then connect your live keys.',
  ],
  ar: [
    'ادخل على لوحة تحكم Kashier ‏(merchant.kashier.io). رقم التاجر (MID-…) موجود تحت اسم المستخدم في الشريط العلوي.',
    'اختار الوضع من زر "It\'s live data" في القائمة الجانبية: مقفول لمفاتيح التجربة، مفتوح لمفاتيح التشغيل. المفاتيح مختلفة لكل وضع.',
    'افتح Integrations ‏(merchant.kashier.io/en/dashboard/integration) وانسخ الـ Payment API key والـ Secret key الخاصين بالوضع ده.',
    'الصق القيم التلاتة هنا واضغط ربط. هنعرف من المفاتيح إذا كانت تجربة ولا تشغيل، وهنقرا طرق الدفع المتاحة في حسابك (كارت، محفظة).',
    'مش محتاج تعمل حاجة تانية علشان المدفوعات: إحنا بنبعت لـ Kashier رابط الـ webhook مع كل عملية دفع. لو عايز الاستردادات اللي بتعملها من لوحة Kashier نفسها تظهر عندنا، ضيف رابط الـ webhook اللي تحت كـ webhook في Kashier (الأحداث: refund و partial_refund و void).',
    'لو مفعّل قائمة الـ IP المسموح بيها في Kashier، ضيف عنوان السيرفر بتاعنا كمان، وإلا Kashier هيرفض طلباتنا.',
    'ابدأ بوضع التجربة: اعمل طلب من معاينة المتجر وادفع بكارت تجريبي من Kashier، وبعدها اربط مفاتيح التشغيل.',
  ],
};

const helpLinks = [
  { label: bi('Kashier API keys', 'مفاتيح Kashier'), url: 'https://developers.kashier.io/docs/get-started/api-keys' },
  { label: bi('Kashier webhooks', 'الـ Webhooks في Kashier'), url: 'https://developers.kashier.io/docs/webhooks' },
  { label: bi('Kashier test cards', 'كروت التجربة في Kashier'), url: 'https://developers.kashier.io/docs/get-started/testing' },
  { label: bi('Kashier dashboard', 'لوحة تحكم Kashier'), url: 'https://merchant.kashier.io/en/dashboard/integration' },
];

// Kashier is given our URL per session (serverWebhook), so the merchant pastes
// nothing for payments; registering it in Kashier's dashboard only adds
// refunds made there. Where exactly that screen sits in the dashboard is not
// published, hence the general name.
const webhookSetup = {
  field: 'Webhooks',
  perIntegration: false,
  automatic: true,
};

// A repeated webhook is answered 409, which Kashier reads as "already processed".
const webhookDuplicateStatus = 409;

// ------------------------------------------------------------------ helpers

const hosts = () => env.payments.kashier;

function hostFor(creds, kind) {
  const mode = creds && creds.mode;
  if (mode !== 'test' && mode !== 'live') {
    throw new GatewayError('This Kashier account has no mode on record. Connect it again.');
  }
  const h = hosts();
  if (kind === 'fep') return mode === 'test' ? h.testFepUrl : h.liveFepUrl;
  return mode === 'test' ? h.testApiUrl : h.liveApiUrl;
}

const secretsOf = (creds) => [creds && creds.secretKey, creds && creds.apiKey];

/** Our minor units -> Kashier's decimal string: 12345 -> "123.45". */
function toDecimal(minor) {
  const n = Math.round(Number(minor));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Kashier's major-unit amount (number or string) -> our minor units; NaN when absent. */
function toMinor(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

/** encodeURIComponent plus !'()* — RFC 3986, what query-string's strict mode produces. */
function strictEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The string Kashier signs a webhook over: the signatureKeys, sorted, as
 * `key=value` joined with `&`, values strictly encoded. Mirrors
 * `queryString.stringify(_.pick(data, keys))` from Kashier's own sample,
 * including its handling of null (bare key), undefined (skipped) and arrays
 * (the key repeated).
 */
function signaturePayload(data, keys) {
  const parts = [];
  for (const key of [...keys].sort()) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (value === undefined) continue;
    if (value === null) {
      parts.push(strictEncode(key));
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined) continue;
      parts.push(v === null ? strictEncode(key) : `${key}=${strictEncode(typeof v === 'object' ? JSON.stringify(v) : String(v))}`);
    }
  }
  return parts.join('&');
}

function hmacHex(secret, text) {
  return crypto.createHmac('sha256', String(secret)).update(text, 'utf8').digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a.toLowerCase());
  const y = Buffer.from(b.toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function headerValue(headers, key) {
  if (!headers) return '';
  const value = headers[key] !== undefined ? headers[key] : headers[key.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : typeof value === 'string' ? value : '';
}

function localized(message) {
  if (!message) return null;
  if (typeof message === 'string') return message;
  if (typeof message === 'object') return message.en || message.ar || null;
  return null;
}

function messageFrom(res) {
  const json = res.json || {};
  const candidates = [
    localized(json.messages),
    typeof json.message === 'string' ? json.message : null,
    typeof json.error === 'string' ? json.error : null,
    json.error && typeof json.error === 'object' && typeof json.error.cause === 'string' ? json.error.cause : null,
    json.response && typeof json.response === 'object' ? json.response.gatewayMessage : null,
    json.response && typeof json.response === 'object' ? localized(json.response.transactionResponseMessage) : null,
    Array.isArray(json.more_info) && json.more_info[0] ? json.more_info[0].message : null,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c.trim());
  if (found) return found;
  return res.text ? res.text.slice(0, 200) : `HTTP ${res.status}`;
}

/** A non-2xx response as the error the callers expect. */
function errorFor(res, creds, what) {
  const detail = sanitizeGatewayMessage(messageFrom(res), secretsOf(creds));
  if (res.status === 401) return new GatewayAuthError(name);
  if (res.status === 403) {
    // Kashier answers 403 for an IP allow-list miss — a setting, not a bad key.
    if (/ip/i.test(detail)) {
      return new GatewayRejectedError(
        `Kashier refused our server's address (${detail}). Add it to the IP allow-list in your Kashier account, or clear the list.`
      );
    }
    return new GatewayAuthError(name);
  }
  if (res.status >= 400 && res.status < 500) return new GatewayRejectedError(`Kashier refused to ${what}: ${detail}`);
  return new GatewayError(`Kashier could not ${what} right now (HTTP ${res.status}).`);
}

async function send(creds, opts, what) {
  try {
    return await gatewayHttp.request(opts);
  } catch (err) {
    throw new GatewayError(`Kashier could not be reached to ${what} (${err.message}).`);
  }
}

async function call(creds, opts, what) {
  const res = await send(creds, opts, what);
  if (!res.ok) throw errorFor(res, creds, what);
  return res;
}

/**
 * Whether a refusal is Kashier's balance check. The wording is not published;
 * this matches the phrases a balance refusal is expected to carry, and
 * anything else is an ordinary failure.
 */
function isBalanceRefusal(text) {
  return typeof text === 'string' && /insufficient|not enough (balance|funds)|available balance|balance (is )?(too )?low/i.test(text);
}

// ------------------------------------------------------------ normalization

const PAYMENT_EVENTS = ['pay', 'capture', 'reject'];
const REFUND_EVENTS = ['refund', 'partial_refund'];
const VOID_EVENTS = ['void', 'reversal'];

function kindOfEvent(event) {
  const e = String(event || '').toLowerCase();
  if (PAYMENT_EVENTS.includes(e)) return 'payment';
  if (REFUND_EVENTS.includes(e)) return 'refund';
  if (VOID_EVENTS.includes(e)) return 'void';
  return null;
}

/** What we keep of a webhook / redirect in the event inbox: no customer data, the card masked to its last four. */
function storablePayload(event, data) {
  const keep = { event: String(event || '').toLowerCase() };
  for (const key of [
    'merchantOrderId',
    'kashierOrderId',
    'orderReference',
    'transactionId',
    'status',
    'method',
    'amount',
    'currency',
    'creationDate',
    'transactionResponseCode',
  ]) {
    if (data[key] !== undefined && data[key] !== null) keep[key] = data[key];
  }
  const responseMessage = localized(data.transactionResponseMessage);
  if (responseMessage) keep.transactionResponseMessage = responseMessage;
  const cardInfo = (data.card && data.card.cardInfo) || {};
  const masked = cardInfo.maskedCard || data.maskedCard;
  if (masked) keep.cardLast4 = String(masked).replace(/\D/g, '').slice(-4);
  const brand = cardInfo.cardBrand || data.cardBrand;
  if (brand) keep.cardBrand = String(brand).slice(0, 30);
  return keep;
}

/**
 * One Kashier transaction as our code talks about it (see gateways/index.js),
 * from a storable payload (so the sweep can re-normalize a stored event).
 */
function normalizeTransaction(p) {
  const kind = kindOfEvent(p.event) || 'payment';
  const raw = String(p.status || '').toUpperCase();
  let status;
  if (kind === 'payment') {
    if (String(p.event).toLowerCase() === 'reject') status = 'failed';
    else if (raw === 'SUCCESS') status = 'paid';
    else if (raw === 'FAILURE') status = 'failed';
    else status = 'pending';
  } else if (raw === 'SUCCESS') status = 'processed';
  else if (raw === 'FAILURE') status = 'failed';
  else status = 'pending';

  const message = p.transactionResponseMessage || p.transactionResponseCode || null;
  const failed = status === 'failed';
  return {
    kind,
    status,
    transactionId: p.transactionId ? String(p.transactionId) : null,
    // Kashier's refund notification carries no link to the payment's
    // transaction; refunds are matched on the order reference instead.
    parentTransactionId: null,
    providerOrderId: p.merchantOrderId !== undefined && p.merchantOrderId !== null && p.merchantOrderId !== '' ? String(p.merchantOrderId) : null,
    amount: toMinor(p.amount),
    currency: p.currency ? String(p.currency).toUpperCase() : null,
    maskedDisplay: p.cardLast4 ? `${p.cardBrand ? `${p.cardBrand} ` : ''}•••• ${p.cardLast4}`.slice(0, 100) : null,
    failureReason: failed && message ? String(message).slice(0, 300) : failed && kind === 'payment' ? 'The payment was declined' : null,
    failureCode: failed && kind !== 'payment' && isBalanceRefusal(String(message || '')) ? INSUFFICIENT_BALANCE : null,
    isTest: null,
  };
}

// ----------------------------------------------------------------- connect

/** 'test' | 'live' | null: the mode recorded when the account was connected. */
function modeFromCredentials(creds) {
  return creds && (creds.mode === 'test' || creds.mode === 'live') ? creds.mode : null;
}

/** Which of our methods this account can take: what Kashier said it is entitled to. */
function availableMethods(settings = {}) {
  const entitled = Array.isArray(settings.entitledMethods) ? settings.entitledMethods : [];
  return METHODS.filter((m) => entitled.includes(m));
}

/** The secret key is accepted on this mode's host (an orders search that matches nothing). */
async function secretKeyWorksOn(creds, mode) {
  const probe = { ...creds, mode };
  const url = `${hostFor(probe, 'api')}/v3/payment/orders?search=${encodeURIComponent('connect-check')}&limit=1`;
  const res = await send(probe, { method: 'GET', url, headers: { authorization: creds.secretKey }, retry: true }, 'check these keys');
  if (res.ok) return true;
  if (res.status === 401) return false;
  throw errorFor(res, probe, 'check these keys');
}

async function detectMode(creds) {
  if (await secretKeyWorksOn(creds, 'test')) return 'test';
  if (await secretKeyWorksOn(creds, 'live')) return 'live';
  throw new GatewayAuthError(name);
}

/** The methods Kashier says this merchant ID can take, in this mode. */
async function entitlements(creds) {
  const url = `${hostFor(creds, 'api')}/v2/merchants/${encodeURIComponent(creds.merchantId)}/paymentMethods`;
  const res = await send(creds, { method: 'GET', url, retry: true }, 'look up this merchant ID');
  if (res.status === 400 || res.status === 404) {
    throw new GatewayRejectedError(
      `Kashier does not know the merchant ID ${creds.merchantId} in ${creds.mode} mode. Copy it from the top bar of your Kashier dashboard.`
    );
  }
  if (!res.ok) throw errorFor(res, creds, 'look up this merchant ID');
  const json = res.json && typeof res.json === 'object' ? res.json : {};
  const map = json.data && typeof json.data === 'object' && !Array.isArray(json.data) ? json.data : json;
  return METHODS.filter((m) => map[m] === true || map[m] === 'true');
}

/**
 * Whether Kashier says the Payment API key belongs to this mode. The answer's
 * shape is not published, so only an explicit "not valid" in it refuses the
 * key; an answer we cannot read lets the connect go ahead (a wrong key then
 * shows as webhooks failing their signature and sessions being refused).
 */
async function checkApiKey(creds) {
  const url = `${hostFor(creds, 'api')}/v2/merchants/validate-credentials`;
  const res = await send(
    creds,
    {
      method: 'POST',
      url,
      headers: { authorization: creds.secretKey },
      body: { apiKeys: [{ mode: creds.mode, key: creds.apiKey }] },
    },
    'check the Payment API key'
  );
  if (!res.ok) return;
  const saysInvalid = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 5) return false;
    if (Array.isArray(node)) return node.some((n) => saysInvalid(n, depth + 1));
    for (const [key, value] of Object.entries(node)) {
      if (/^(is)?valid$/i.test(key) && (value === false || value === 'false')) return true;
      if (typeof value === 'object' && saysInvalid(value, depth + 1)) return true;
    }
    return false;
  };
  if (saysInvalid(res.json)) {
    throw new GatewayRejectedError(
      `Kashier says this Payment API key is not a ${creds.mode} key for this account. Copy the Payment API key from the same mode as the Secret key.`
    );
  }
}

/**
 * Connect: the secret key picks the mode (it works on exactly one of the two
 * hosts), the merchant ID must be known in that mode, and the Payment API key
 * must not be refused. Returns the mode, the credentials to store (with the
 * mode, which later calls need to pick the host) and the settings (the
 * methods the account is entitled to).
 */
async function verifyCredentials(creds) {
  const mode = await detectMode(creds);
  const stored = { merchantId: creds.merchantId, apiKey: creds.apiKey, secretKey: creds.secretKey, mode };
  const entitled = await entitlements(stored);
  if (entitled.length === 0) {
    throw new ValidationError(
      [{ field: 'credentials.merchantId', message: `This Kashier account (${mode} mode) takes neither card nor wallet payments.` }],
      'Invalid body'
    );
  }
  await checkApiKey(stored);
  return { mode, credentials: stored, settings: { entitledMethods: entitled } };
}

// ----------------------------------------------------------------- payments

/**
 * Our reference for one attempt, sent as `order` and reported back as
 * merchantOrderId. Unique per attempt (it carries the attempt id), readable
 * in Kashier's dashboard (it starts with the order number).
 */
function orderReference(order, attempt) {
  const prefix = String(order.orderNumber || 'order').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `${prefix}-${String(attempt.id).replace(/-/g, '')}`;
}

/**
 * Creates the payment session and returns where to send the shopper.
 *
 * @returns {{ providerOrderId: string, providerReference: string, redirectUrl: string }}
 */
async function createPayment(creds, { attempt, order, method, settings, returnUrl, webhookUrl, expiresInSeconds, storeName, locale }) {
  if (!availableMethods(settings).includes(method)) {
    throw new AppError('PAYMENT_METHOD_UNAVAILABLE', `This store cannot take ${method} payments right now`, 422);
  }
  const contact = order.contactSnapshot || {};
  const reference = orderReference(order, attempt);
  const lifetime = Math.max(60, Math.floor(expiresInSeconds) - SESSION_EXPIRY_MARGIN_SECONDS);

  const body = {
    expireAt: new Date(Date.now() + lifetime * 1000).toISOString(),
    maxFailureAttempts: MAX_FAILURE_ATTEMPTS,
    paymentType: 'credit',
    amount: toDecimal(attempt.amount),
    currency: attempt.currency,
    order: reference,
    merchantId: creds.merchantId,
    merchantRedirect: returnUrl,
    serverWebhook: webhookUrl,
    display: String(locale || '').toLowerCase().startsWith('en') ? 'en' : 'ar',
    type: 'one-time',
    // The shopper already chose the method on the store; Kashier's page
    // offers only that one.
    allowedMethods: method,
    defaultMethod: method,
    // Let the shopper try again on Kashier's page before coming back.
    failureRedirect: false,
    manualCapture: false,
    description: `Order ${order.orderNumber}${storeName ? ` - ${storeName}` : ''}`.slice(0, 119),
    customer: {
      email: contact.email || `no-email@${env.platformRootDomain}`,
      reference: String(order.customerId || order.id),
    },
    metaData: { orderId: order.id, attemptId: attempt.id },
  };

  const res = await call(
    creds,
    {
      method: 'POST',
      url: `${hostFor(creds, 'api')}/v3/payment/sessions`,
      headers: { authorization: creds.secretKey, 'api-key': creds.apiKey },
      body,
      timeoutMs: gatewayHttp.WRITE_TIMEOUT_MS,
    },
    'start this payment'
  );
  const json = res.json || {};
  const session = json.data && json.data._id ? json.data : json;
  if (!session._id || !session.sessionUrl) throw new GatewayError('Kashier accepted the payment but returned no payment page.');
  return { providerOrderId: reference, providerReference: String(session._id), redirectUrl: String(session.sessionUrl) };
}

// Session states, from the session document's status enum.
const SESSION_PAID = ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_PENDING'];
const SESSION_FAILED = ['FAILED', 'EXPIRED', 'ABANDONED', 'REJECTED', 'VOIDED', 'REVERSED'];
const SESSION_PENDING = ['PENDING', 'AUTHORIZED'];
// Order states, from the orders search.
const ORDER_FAILED = ['FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'REVERSED'];

async function sessionPayment(creds, sessionId) {
  const res = await send(
    creds,
    {
      method: 'GET',
      url: `${hostFor(creds, 'api')}/v3/payment/sessions/${encodeURIComponent(sessionId)}/payment`,
      headers: { authorization: creds.secretKey },
      retry: true,
    },
    'check this payment'
  );
  if (res.status === 404) return null;
  if (!res.ok) throw errorFor(res, creds, 'check this payment');
  const json = res.json || {};
  return json.data && typeof json.data === 'object' ? json.data : null;
}

/** Kashier's order for our reference (orders search is a partial match; only an exact one counts). */
async function findOrder(creds, reference) {
  const query = new URLSearchParams({ search: reference, limit: '5' });
  const res = await send(
    creds,
    {
      method: 'GET',
      url: `${hostFor(creds, 'api')}/v3/payment/orders?${query.toString()}`,
      headers: { authorization: creds.secretKey },
      retry: true,
    },
    'look up this payment'
  );
  if (res.status === 404) return null;
  if (!res.ok) throw errorFor(res, creds, 'look up this payment');
  const rows = res.json && Array.isArray(res.json.data) ? res.json.data : [];
  return rows.find((o) => o && String(o.merchantOrderId) === String(reference)) || null;
}

function paymentTransactionOf(order) {
  const txs = Array.isArray(order.transactions) ? order.transactions : [];
  return txs.find((t) => t && String(t.operation).toLowerCase() === 'pay' && String(t.status).toUpperCase() === 'SUCCESS') || null;
}

/**
 * What Kashier knows about an attempt: the session first (it answers for a
 * session nobody has paid yet), then the order itself when the session cannot
 * be read.
 *
 * @returns {{ found: false } | { found: true, transaction, payload }}
 */
async function inquire(creds, { payment }) {
  const reference = payment.providerOrderId;
  if (!reference) return { found: false };

  const session = payment.providerReference ? await sessionPayment(creds, payment.providerReference) : null;
  let status = null;
  let amount = null;
  let currency = null;
  let transactionId = null;
  let failureReason = null;

  if (session) {
    const s = String(session.status || '').toUpperCase();
    if (SESSION_PAID.includes(s)) status = 'SUCCESS';
    else if (SESSION_FAILED.includes(s)) {
      status = 'FAILURE';
      failureReason = s === 'VOIDED' || s === 'REVERSED' ? 'The payment was cancelled at Kashier' : `Kashier session ${s.toLowerCase()}`;
    } else if (SESSION_PENDING.includes(s)) status = 'PENDING';
    else return { found: false };
    amount = session.amount;
    currency = session.currency;
  } else {
    const order = await findOrder(creds, reference);
    if (!order) return { found: false };
    const s = String(order.status || '').toUpperCase();
    const paid = paymentTransactionOf(order);
    if (s === 'CAPTURED') status = 'SUCCESS';
    else if (ORDER_FAILED.includes(s)) {
      status = 'FAILURE';
      failureReason = `Kashier order ${s.toLowerCase()}`;
    } else if (Array.isArray(order.transactions) && order.transactions.length > 0) status = 'PENDING';
    else return { found: false };
    if (paid && paid.transactionId) transactionId = paid.transactionId;
  }

  const payload = {
    event: 'pay',
    merchantOrderId: reference,
    status,
    ...(transactionId ? { transactionId } : {}),
    ...(amount !== null && amount !== undefined ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(failureReason ? { transactionResponseMessage: failureReason } : {}),
  };
  return { found: true, transaction: normalizeTransaction(payload), payload };
}

/** One transaction by its Kashier id — how a refund left pending is looked up. Null when Kashier does not know it. */
async function inquireTransaction(creds, { transactionId }) {
  const res = await send(
    creds,
    {
      method: 'GET',
      url: `${hostFor(creds, 'api')}/v2/aggregator/transactions/${encodeURIComponent(transactionId)}`,
      headers: { authorization: creds.secretKey },
      retry: true,
    },
    'check this transaction'
  );
  if (res.status === 404) return null;
  if (!res.ok) throw errorFor(res, creds, 'check this transaction');
  const body = (res.json && (res.json.body || res.json.data)) || {};
  const type = String(body.trxType || body.operation || '').toLowerCase();
  const event = REFUND_EVENTS.includes(type) ? 'refund' : VOID_EVENTS.includes(type) ? 'void' : 'pay';
  return normalizeTransaction({
    event,
    status: body.status || body.paymentStatus,
    transactionId: body.transactionId || transactionId,
    merchantOrderId: body.merchantOrderId,
    amount: body.amount,
    currency: body.currency,
    transactionResponseMessage: localized(body.transactionResponseMessage),
    transactionResponseCode: body.transactionResponseCode,
  });
}

/** The outcome of a refund / void call's 200 answer. */
function refundOutcome(json) {
  const response = json.response && typeof json.response === 'object' ? json.response : {};
  const known = ['SUCCESS', 'FAILURE', 'PENDING'];
  const raw = [response.status, response.result, json.status]
    .map((v) => String(v || '').toUpperCase())
    .find((v) => known.includes(v));
  const transactionId =
    json.transactionId || response.transactionId || (response.transaction && response.transaction.id) || null;
  const message = localized(json.messages) || response.gatewayMessage || localized(response.transactionResponseMessage) || null;
  if (raw === 'SUCCESS') return { status: 'processed', providerRefundReference: transactionId, failureReason: null };
  if (raw === 'PENDING' || !raw) return { status: 'pending', providerRefundReference: transactionId, failureReason: null };
  return {
    status: 'failed',
    providerRefundReference: transactionId,
    failureReason: message ? String(message).slice(0, 300) : 'Kashier declined the refund',
    failureCode: isBalanceRefusal(message) ? INSUFFICIENT_BALANCE : null,
  };
}

async function orderOperation(creds, kashierOrderId, body) {
  return send(
    creds,
    {
      method: 'PUT',
      url: `${hostFor(creds, 'fep')}/v3/orders/${encodeURIComponent(kashierOrderId)}`,
      headers: { authorization: creds.secretKey },
      body,
      timeoutMs: gatewayHttp.WRITE_TIMEOUT_MS,
    },
    'refund this payment'
  );
}

function refusalOf(res, creds) {
  const detail = sanitizeGatewayMessage(messageFrom(res), secretsOf(creds));
  if (isBalanceRefusal(detail)) {
    return {
      status: 'failed',
      providerRefundReference: null,
      failureReason: `Not enough available balance in your Kashier account for this refund (${detail}).`.slice(0, 300),
      failureCode: INSUFFICIENT_BALANCE,
    };
  }
  return null;
}

/**
 * Refunds `amount` (our minor units) of a paid attempt. The whole amount of a
 * payment that has not settled yet is VOIDED instead (cancelled before any
 * money moved); a void Kashier refuses falls back to a refund.
 *
 * Kashier's order id is looked up first. That lookup failing is a definite
 * "nothing happened", so it is thrown as a refusal, never left pending.
 *
 * @returns {{ status: 'processed'|'pending'|'failed', providerRefundReference, failureReason, failureCode? }}
 */
async function refund(creds, { payment, amount }) {
  if (!payment.providerOrderId) throw new GatewayRejectedError('This payment has no Kashier order to refund.');
  let order;
  try {
    order = await findOrder(creds, payment.providerOrderId);
  } catch (err) {
    if (err instanceof GatewayAuthError) throw err;
    throw new GatewayRejectedError(`The refund was not sent: ${err.message}`);
  }
  if (!order || !order.orderId) throw new GatewayRejectedError('Kashier has no order for this payment, so nothing was refunded.');

  const paid = paymentTransactionOf(order);
  const target = payment.providerTransactionId || (paid && paid.transactionId) || null;
  const whole = Number(amount) === Number(payment.amount);
  if (whole && target && paid && paid.isSettled === false) {
    const res = await orderOperation(creds, order.orderId, {
      apiOperation: 'VOID',
      transaction: { amount: Number(toDecimal(amount)), targetTransactionId: target },
    });
    if (res.ok) return refundOutcome(res.json || {});
    if (res.status >= 500 || res.status === 401) throw errorFor(res, creds, 'void this payment');
    // A definite refusal (settled after all, say): refund it instead.
  }

  const res = await orderOperation(creds, order.orderId, {
    apiOperation: 'REFUND',
    reason: 'Refund',
    transaction: { amount: Number(toDecimal(amount)) },
  });
  if (res.ok) return refundOutcome(res.json || {});
  if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
    const balance = refusalOf(res, creds);
    if (balance) return balance;
  }
  throw errorFor(res, creds, 'refund this payment');
}

// ---------------------------------------------------------------- callbacks

// Kashier's markers for a notification that repeats one already sent.
function isReplay(event, data) {
  return String(event).toLowerCase() === 'idempotency' || String(data.transactionResponseCode || '').toUpperCase() === 'ORDER_PAID_BEFORE';
}

/**
 * The server webhook. Null for a notification we do not act on (an
 * authorization, a transfer, a replay) — acknowledged and dropped. Throws
 * nothing; `valid: false` means the signature did not match, or did not
 * cover the fields we would act on.
 *
 * @returns {null | { valid: boolean, eventKey, transaction, payload }}
 */
function parseWebhook({ body, headers }, creds) {
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') return null;
  const { event, data } = body;
  if (isReplay(event, data) || !kindOfEvent(event)) return null;

  const keys = Array.isArray(data.signatureKeys) ? data.signatureKeys.filter((k) => typeof k === 'string') : [];
  const covers = REQUIRED_SIGNED_FIELDS.every((field) => keys.includes(field));
  const expected = hmacHex(creds.apiKey, signaturePayload(data, keys));
  const valid = covers && safeEqualHex(expected, headerValue(headers, 'x-kashier-signature'));

  const payload = storablePayload(event, data);
  const transaction = normalizeTransaction(payload);
  return {
    valid,
    // Kashier's own advice: a transaction in a given state is one event.
    eventKey: transaction.transactionId ? `tx:${transaction.transactionId}:${String(data.status || '').toUpperCase()}` : `sig:${expected}`,
    transaction,
    payload,
  };
}

/**
 * The shopper's redirect back to the store. Signed with the Payment API key
 * over the query string as received, without `signature` and `mode` — the
 * scheme of Kashier's hosted-page samples; the session docs do not restate it,
 * so a redirect that does not verify simply falls back to asking Kashier.
 */
function parseRedirect(query, creds) {
  if (!query || typeof query !== 'object' || !query.signature || !query.merchantOrderId) return null;
  const flat = {};
  for (const [key, value] of Object.entries(query)) flat[key] = Array.isArray(value) ? value[0] : value;
  const signed = Object.entries(flat)
    .filter(([key]) => key !== 'signature' && key !== 'mode')
    .map(([key, value]) => `${key}=${value === null || value === undefined ? '' : String(value)}`)
    .join('&');
  const valid = safeEqualHex(hmacHex(creds.apiKey, signed), String(flat.signature));
  const data = {
    merchantOrderId: flat.merchantOrderId,
    kashierOrderId: flat.orderId,
    orderReference: flat.orderReference,
    transactionId: flat.transactionId,
    status: flat.paymentStatus,
    amount: flat.amount,
    currency: flat.currency,
    maskedCard: flat.maskedCard,
    cardBrand: flat.cardBrand,
  };
  const payload = storablePayload('pay', data);
  const transaction = normalizeTransaction(payload);
  return {
    valid,
    // The same key as the webhook for the same transaction, so the two dedupe.
    eventKey: transaction.transactionId ? `tx:${transaction.transactionId}:${String(flat.paymentStatus || '').toUpperCase()}` : `redirect:${flat.signature}`,
    transaction,
    payload,
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
  webhookDuplicateStatus,
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
  normalizeTransaction,
  // Exposed for tests.
  signaturePayload,
  hmacHex,
  toDecimal,
  toMinor,
  orderReference,
  INSUFFICIENT_BALANCE,
  REQUIRED_SIGNED_FIELDS,
};
