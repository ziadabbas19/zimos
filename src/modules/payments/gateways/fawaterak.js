'use strict';

const crypto = require('crypto');
const Joi = require('joi');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const gatewayHttp = require('./gatewayHttp');
const { GatewayAuthError, GatewayRejectedError, GatewayError, sanitizeGatewayMessage } = require('./gatewayErrors');
const { AppError, ValidationError } = require('../../../core/errors/AppError');
const { verifyWebhook } = require('../../billing/fawaterak/signature');
const { toMajor, toMinor } = require('../../billing/fawaterak/amounts');
const { BASE_URLS } = require('../../billing/fawaterak/config');

/**
 * Fawaterak (Egypt) adapter, stage 1: card payments only, through the
 * merchant's own Fawaterak account. Facts used here, from Fawaterak's API v3
 * reference (app.fawaterk.com/documentation, checked 2026-10-23):
 *
 *   Hosts              staging: staging.fawaterk.com   live: app.fawaterk.com
 *                      Separate accounts with separate keys: the OAuth client
 *                      works on exactly one host, which is how the mode is
 *                      detected.
 *   Token              POST {host}/oauth/token  { grant_type: client_credentials,
 *                      client_id, client_secret } -> { access_token, expires_in }
 *                      Every /api/v3 call: Authorization: Bearer <access_token>
 *   Methods            GET {host}/api/v3/getTrPaymentmethods
 *                      -> data: [{ payment_method_id, name_en, commission_on_customer, ... }]
 *                      only what the merchant switched on in Fawaterak
 *   Create (direct)    POST {host}/api/v3/createTransaction with payment_method_id
 *                      -> data: { intent_key, payment_data: { redirectTo } }
 *                      The shopper sees the card page only, never Fawry or a
 *                      wallet. Amounts are major units (EGP 12.50).
 *   Inquiry            POST {host}/api/v3/getTransactionData { intent_key }
 *                      -> data: { paid 0|1, total, currency, transaction_id, pay_load, ... }
 *                      422 for an intent it does not know
 *
 * Webhooks. The paid webhook goes to the webhookUrl sent with each payment
 * (a path ending in `_json`, so the body is JSON). Its signature,
 * transactionHashKey, is HMAC-SHA256 with the merchant's vendor API key over
 * TransactionId / TransactionKey / PaymentMethod ONLY: the status, the amount,
 * the currency and pay_load are unsigned, and nothing carries a timestamp. So
 * a verified webhook only says which payment to ask about
 * (webhookConfirmsByInquiry): what is paid, and for how much, comes from
 * getTransactionData, asked with the OAuth token — a separate credential.
 * The redirect back to the store is not signed at all (parseRedirect: null),
 * so the return page asks Fawaterak too.
 *
 * Refunds are made in the merchant's Fawaterak dashboard in stage 1
 * (refundsInGatewayDashboard): its refund API is a request approved later,
 * and its refund webhook names no refund of its own.
 */

const code = 'fawaterak';
const name = 'Fawaterak';

const METHODS = ['card'];
// getTransactionData reports its total "converted to EGP".
const CURRENCIES = ['EGP'];

// The card page stops taking payments this long before our attempt expires,
// if Fawaterak honours due_date for it (not stated in the reference).
const DUE_DATE_MARGIN_SECONDS = 120;
const TOKEN_MAX_TTL_MS = 60 * 60 * 1000;
const TOKEN_MARGIN_MS = 60 * 1000;
const TOKEN_FALLBACK_TTL_MS = 5 * 60 * 1000;

// Marks a stored payload as Fawaterak's own answer to getTransactionData.
// Only inquire() writes it; a webhook payload never carries it.
const VERIFIED = 'getTransactionData';

const credentialsSchema = Joi.object({
  clientId: Joi.string().trim().min(8).max(200).required(),
  clientSecret: Joi.string().trim().min(10).max(500).required(),
  vendorKey: Joi.string().trim().min(10).max(500).required(),
});

// Filled in by verifyCredentials from what the Fawaterak account offers;
// nothing here is typed by the merchant.
const settingsSchema = Joi.object({
  cardMethodId: Joi.number().integer().positive().optional(),
  customerPaysFees: Joi.boolean().optional(),
});

const bi = (en, ar) => ({ en, ar });

const credentialFields = [
  { key: 'clientId', secret: false, label: bi('Client ID', 'معرّف العميل (Client ID)') },
  { key: 'clientSecret', secret: true, label: bi('Client secret', 'السر الخاص بالعميل (Client secret)') },
  { key: 'vendorKey', secret: true, label: bi('API key (vendor key)', 'مفتاح الـ API ‏(API key)') },
];

const settingFields = [];

const setupSteps = {
  en: [
    'For a test, create an account at staging.fawaterk.com; for real payments use your account at app.fawaterk.com (Fawaterak activates live accounts after verifying them). Keys are separate for each.',
    'In Fawaterak, open Business settings → Payment methods and switch on Visa / Mastercard. Only card payments are taken through Fawaterak for now.',
    'Open Integrations → OAuth client credentials and copy the Client ID and the Client secret.',
    'Open Integrations and copy the API key (vendor key). We use it only to check that payment notifications really come from Fawaterak.',
    'Paste the three values here and connect. We detect a test or a live account from the keys and read whether card payments are switched on.',
    'Nothing else is needed: we give Fawaterak the notification URL with every payment. Refunds are made in your Fawaterak dashboard.',
    'Start with a test account: place an order from the store preview and pay with a Fawaterak test card, then connect your live keys.',
  ],
  ar: [
    'للتجربة أنشئ حسابًا على staging.fawaterk.com، وللمدفوعات الحقيقية استخدم حسابك على app.fawaterk.com (تفعّل Fawaterak حسابات التشغيل بعد التحقق منها). المفاتيح مختلفة لكل منهما.',
    'في Fawaterak افتح Business settings ← Payment methods وفعّل Visa / Mastercard. تُقبل مدفوعات البطاقات فقط عبر Fawaterak حاليًا.',
    'افتح Integrations ← OAuth client credentials وانسخ الـ Client ID والـ Client secret.',
    'افتح Integrations وانسخ الـ API key (مفتاح التاجر). نستخدمه فقط للتأكد من أن إشعارات الدفع مرسلة من Fawaterak فعلًا.',
    'الصق القيم الثلاث هنا واضغط ربط. نتعرّف من المفاتيح على نوع الحساب (تجربة أو تشغيل) ونتحقق من تفعيل الدفع بالبطاقة.',
    'لا حاجة لأي خطوة أخرى: نرسل لـ Fawaterak رابط الإشعارات مع كل عملية دفع. الاسترداد يتم من لوحة تحكم Fawaterak.',
    'ابدأ بحساب تجربة: أنشئ طلبًا من معاينة المتجر وادفع ببطاقة تجريبية من Fawaterak، ثم اربط مفاتيح التشغيل.',
  ],
};

const helpLinks = [
  { label: bi('Fawaterak API documentation', 'توثيق Fawaterak للمطورين'), url: 'https://app.fawaterk.com/documentation' },
  { label: bi('Fawaterak dashboard', 'لوحة تحكم Fawaterak'), url: 'https://app.fawaterk.com' },
  { label: bi('Fawaterak test (staging) dashboard', 'لوحة تجربة Fawaterak'), url: 'https://staging.fawaterk.com' },
];

// Fawaterak is given our URL with every payment (redirectionUrls.webhookUrl),
// so the merchant pastes nothing.
const webhookSetup = {
  field: 'Webhook',
  perIntegration: false,
  automatic: true,
};

// The paid webhook is sent as JSON only to a URL whose path has `_json` in
// it: ours is the account's webhook URL plus this segment.
const WEBHOOK_VARIANT = 'paid_json';
const webhookVariants = [WEBHOOK_VARIANT];

// ------------------------------------------------------------------ helpers

function hostFor(creds) {
  const mode = creds && creds.mode;
  if (mode === 'test') return BASE_URLS.staging;
  if (mode === 'live') return BASE_URLS.live;
  throw new GatewayError('This Fawaterak account has no mode on record. Connect it again.');
}

const secretsOf = (creds, token) => [creds && creds.clientSecret, creds && creds.vendorKey, creds && creds.clientId, token];

function messageFrom(res) {
  const json = res.json || {};
  if (json.errors && typeof json.errors === 'object') {
    const first = Object.entries(json.errors).find(([, v]) => Array.isArray(v) && typeof v[0] === 'string');
    if (first) return `${first[0]}: ${first[1][0]}`;
  }
  for (const value of [json.message, json.error_description, json.error]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return res.text ? res.text.slice(0, 200) : `HTTP ${res.status}`;
}

/** A non-2xx answer (or a 2xx `status: error`) as the error the callers expect. */
function errorFor(res, creds, token, what) {
  const detail = sanitizeGatewayMessage(messageFrom(res), secretsOf(creds, token));
  if (res.status === 401 || res.status === 403) return new GatewayAuthError(name);
  if ((res.status >= 400 && res.status < 500) || res.ok) return new GatewayRejectedError(`Fawaterak refused to ${what}: ${detail}`);
  return new GatewayError(`Fawaterak could not ${what} right now (HTTP ${res.status}).`);
}

async function send(opts, what) {
  try {
    return await gatewayHttp.request(opts);
  } catch (err) {
    throw new GatewayError(`Fawaterak could not be reached to ${what} (${err.message}).`);
  }
}

// ------------------------------------------------------------------- tokens
//
// One access token per OAuth client — its id AND its secret — and host, in
// this process's memory only: never stored, never logged, never part of an
// error. Reused until min(expires_in, 1 hour) less a minute; concurrent
// callers with the same keys share one token request; a 401 from the API
// drops it and the call is tried once more with a new one (a 401 is refused
// before anything ran, so even a create is safe to repeat). The secret is in
// the key so that the right Client ID with a wrong secret never reads, nor
// waits on, another merchant's token; connecting never reads the cache at all
// (freshTokenOn).

const tokens = new Map(); // key -> { token, expiresAt }
const inFlight = new Map(); // key -> Promise<string|null>

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const tokenKey = (host, creds) => sha256(`${host}\n${creds.clientId}\n${sha256(creds.clientSecret)}`);

/** A new token from `host`, or null when the host refuses these credentials. */
async function requestToken(host, creds) {
  const res = await send(
    {
      method: 'POST',
      url: `${host}/oauth/token`,
      body: { grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret },
    },
    'sign in with these keys'
  );
  if (res.status === 400 || res.status === 401) return null;
  const json = res.json || {};
  if (!res.ok || typeof json.access_token !== 'string' || !json.access_token) {
    throw new GatewayError(`Fawaterak's token endpoint answered HTTP ${res.status} without a token.`);
  }
  const expiresIn = Number(json.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn * 1000, TOKEN_MAX_TTL_MS) : TOKEN_FALLBACK_TTL_MS;
  return { token: json.access_token, expiresAt: Date.now() + Math.max(0, ttl - TOKEN_MARGIN_MS) };
}

/** The cached or a new token for `host`; null when the host refuses the credentials. */
async function tokenOn(host, creds) {
  const key = tokenKey(host, creds);
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      requestToken(host, creds)
        .then((fresh) => {
          if (fresh) tokens.set(key, fresh);
          return fresh ? fresh.token : null;
        })
        .finally(() => inFlight.delete(key))
    );
  }
  return inFlight.get(key);
}

/**
 * A token Fawaterak issues now for these exact keys — never one from the
 * cache, never a request shared with another caller — then kept for the
 * calls that follow. Null when the host refuses the keys.
 */
async function freshTokenOn(host, creds) {
  const fresh = await requestToken(host, creds);
  if (!fresh) return null;
  tokens.set(tokenKey(host, creds), fresh);
  return fresh.token;
}

function dropToken(host, creds, token) {
  const key = tokenKey(host, creds);
  const cached = tokens.get(key);
  if (cached && cached.token === token) tokens.delete(key);
}

function clearTokenCache() {
  tokens.clear();
  inFlight.clear();
}

/** An API call with the Bearer token, tried once more with a new token on a 401. */
async function authorized(creds, opts, what) {
  const host = hostFor(creds);
  const attempt = async () => {
    const token = await tokenOn(host, creds);
    if (!token) throw new GatewayAuthError(name);
    const res = await send({ ...opts, url: `${host}${opts.path}`, headers: { authorization: `Bearer ${token}` } }, what);
    return { res, token };
  };
  let { res, token } = await attempt();
  if (res.status === 401) {
    dropToken(host, creds, token);
    ({ res, token } = await attempt());
  }
  return { res, token };
}

// ---------------------------------------------------------------- connect

/** 'test' | 'live' | null: the mode recorded when the account was connected. */
function modeFromCredentials(creds) {
  return creds && (creds.mode === 'test' || creds.mode === 'live') ? creds.mode : null;
}

/** Which of our methods this account can take: card, once its method id is known. */
function availableMethods(settings = {}) {
  return settings.cardMethodId ? ['card'] : [];
}

/** Codes the dashboard shows as warnings on the connection. */
function connectionNotices(settings = {}) {
  return settings.customerPaysFees ? ['customer_pays_fees'] : [];
}

/**
 * The OAuth client works on exactly one of the two hosts: staging first.
 * Always a new token: the keys being connected are proven by Fawaterak
 * itself, never by a token cached for someone else.
 */
async function detectMode(creds) {
  if (await freshTokenOn(BASE_URLS.staging, creds)) return 'test';
  if (await freshTokenOn(BASE_URLS.live, creds)) return 'live';
  throw new GatewayAuthError(name);
}

/** The account's card method from getTrPaymentmethods, or null. */
function cardMethodOf(list) {
  const rows = Array.isArray(list) ? list : [];
  const switchedOn = rows.filter(
    (m) => m && Number.isSafeInteger(Number(m.payment_method_id)) && Number(m.payment_method_id) > 0 && String(m.integration_status) !== '0'
  );
  const card = switchedOn.find((m) => /visa|master/i.test(String(m.name_en || '')));
  if (!card) return null;
  return { id: Number(card.payment_method_id), customerPaysFees: Number(card.commission_on_customer) === 1 };
}

/**
 * Connect: the OAuth client picks the mode (it works on exactly one host),
 * and the account must have card payments switched on. The vendor key cannot
 * be checked here — Fawaterak only uses it to sign webhooks — so a wrong one
 * shows as webhooks refused, while payments are still recorded from the
 * return page and the sweep. Returns the mode, the credentials to store (with
 * the mode, which later calls need to pick the host) and the settings.
 */
async function verifyCredentials(creds) {
  const mode = await detectMode(creds);
  const stored = { clientId: creds.clientId, clientSecret: creds.clientSecret, vendorKey: creds.vendorKey, mode };
  const { res, token } = await authorized(stored, { method: 'GET', path: '/api/v3/getTrPaymentmethods', retry: true }, 'list the payment methods');
  if (!res.ok || (res.json && res.json.status === 'error')) throw errorFor(res, stored, token, 'list the payment methods');
  const card = cardMethodOf(res.json && res.json.data);
  if (!card) {
    throw new ValidationError(
      [
        {
          field: 'credentials',
          message: `This Fawaterak account (${mode} mode) has no card payment switched on. Switch on Visa / Mastercard under Business settings → Payment methods in Fawaterak, then connect again.`,
        },
      ],
      'Invalid body'
    );
  }
  return { mode, credentials: stored, settings: { cardMethodId: card.id, customerPaysFees: card.customerPaysFees } };
}

// ----------------------------------------------------------------- payments

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: 'Customer', last: 'Customer' };
  if (parts.length === 1) return { first: parts[0].slice(0, 60), last: parts[0].slice(0, 60) };
  return { first: parts[0].slice(0, 60), last: parts.slice(1).join(' ').slice(0, 60) };
}

/** `date` as Fawaterak's due_date wants it: Cairo local time, "Y-m-d H:i:s". */
function cairoDateTime(date) {
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

/** Our reference for one attempt, shown in Fawaterak's dashboard: the order number and the attempt. */
function transactionNumber(order, attempt) {
  const prefix = String(order.orderNumber || 'order').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return `${prefix}-${String(attempt.id).replace(/-/g, '').slice(0, 12)}`;
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch (err) {
    return null;
  }
}

/**
 * Creates the card payment and returns where to send the shopper.
 *
 * @returns {{ providerOrderId: string, providerReference: null, redirectUrl: string }}
 */
async function createPayment(creds, { attempt, order, method, settings, returnUrl, webhookUrl, expiresInSeconds, locale }) {
  if (method !== 'card' || !availableMethods(settings).includes('card')) {
    throw new AppError('PAYMENT_METHOD_UNAVAILABLE', `This store cannot take ${method} payments right now`, 422);
  }
  const contact = order.contactSnapshot || {};
  const { first, last } = splitName(contact.fullName);
  const total = toMajor(attempt.amount);
  const lifetime = Math.max(60, Math.floor(expiresInSeconds) - DUE_DATE_MARGIN_SECONDS);

  const body = {
    payment_method_id: settings.cardMethodId,
    cartTotal: total,
    currency: attempt.currency,
    customer: {
      first_name: first,
      last_name: last,
      ...(contact.email ? { email: String(contact.email) } : {}),
      ...(contact.phone ? { phone: String(contact.phone) } : {}),
    },
    cartItems: [{ name: `Order ${order.orderNumber}`.slice(0, 120), price: total, quantity: 1 }],
    pay_load: { orderId: order.id, attemptId: attempt.id },
    redirectionUrls: {
      successUrl: returnUrl,
      failUrl: returnUrl,
      pendingUrl: returnUrl,
      backUrl: returnUrl,
      webhookUrl: `${webhookUrl}/${WEBHOOK_VARIANT}`,
    },
    due_date: cairoDateTime(new Date(Date.now() + lifetime * 1000)),
    tr_number: transactionNumber(order, attempt),
    sendEmail: false,
    sendSMS: false,
    authAndCapture: 0,
    lang: String(locale || '').toLowerCase().startsWith('en') ? 'en' : 'ar',
  };

  const { res, token } = await authorized(
    creds,
    { method: 'POST', path: '/api/v3/createTransaction', body, timeoutMs: gatewayHttp.WRITE_TIMEOUT_MS },
    'start this payment'
  );
  const json = res.json || {};
  if (!res.ok || json.status === 'error') throw errorFor(res, creds, token, 'start this payment');
  const data = json.data || {};
  const redirectUrl = httpsUrl((data.payment_data && data.payment_data.redirectTo) || data.url);
  if (typeof data.intent_key !== 'string' || !data.intent_key || !redirectUrl) {
    throw new GatewayError('Fawaterak accepted the payment but returned no card page.');
  }
  return { providerOrderId: data.intent_key.slice(0, 100), providerReference: null, redirectUrl };
}

function parsePayLoad(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * One Fawaterak payment as our code talks about it (see gateways/index.js),
 * from a stored payload. Only Fawaterak's own answer to getTransactionData
 * (VERIFIED) can say paid; anything else — a webhook — is a pending
 * transaction that only names the intent to ask about.
 */
function normalizeTransaction(p = {}) {
  const intentKey = p.intent_key || p.transaction_key;
  const transactionId = Number(p.transaction_id);
  const base = {
    kind: 'payment',
    transactionId: Number.isSafeInteger(transactionId) && transactionId > 0 ? String(transactionId) : null,
    parentTransactionId: null,
    providerOrderId: intentKey !== undefined && intentKey !== null && intentKey !== '' ? String(intentKey) : null,
    maskedDisplay: typeof p.payment_method === 'string' && p.payment_method ? p.payment_method.slice(0, 100) : null,
    failureReason: null,
    isTest: null,
  };
  if (p.verified !== VERIFIED) return { ...base, status: 'pending', amount: NaN, currency: null };

  const amount = toMinor(p.total);
  const paid = Number(p.paid) === 1 && p.attemptMatches !== false && Number.isFinite(amount);
  return {
    ...base,
    status: paid ? 'paid' : 'pending',
    amount,
    currency: typeof p.currency === 'string' ? p.currency.trim().toUpperCase() : null,
  };
}

/**
 * What Fawaterak knows about an attempt, by its intent key. Fawaterak never
 * reports a declined card here (paid is 0 or 1): an unpaid intent is
 * pending until our attempt expires or the shopper tries again.
 *
 * @returns {{ found: false } | { found: true, transaction, payload }}
 */
async function inquire(creds, { payment }) {
  if (!payment.providerOrderId) return { found: false };
  const { res, token } = await authorized(
    creds,
    { method: 'POST', path: '/api/v3/getTransactionData', body: { intent_key: payment.providerOrderId }, retry: true },
    'check this payment'
  );
  if (res.status === 422) return { found: false };
  const json = res.json || {};
  if (!res.ok || json.status !== 'success' || !json.data || typeof json.data !== 'object') {
    if (res.status === 401 || res.status === 403) throw new GatewayAuthError(name);
    const detail = sanitizeGatewayMessage(messageFrom(res), secretsOf(creds, token));
    throw new GatewayError(`Fawaterak could not check this payment (HTTP ${res.status}: ${detail}).`);
  }
  const data = json.data;
  if (data.intent_key !== undefined && String(data.intent_key) !== String(payment.providerOrderId)) {
    throw new GatewayError('Fawaterak answered about another payment than the one asked for.');
  }

  // Our own reference, when Fawaterak returns it: it must name this attempt.
  const payLoad = parsePayLoad(data.pay_load);
  const attemptMatches = !payLoad || payLoad.attemptId === undefined || String(payLoad.attemptId) === String(payment.id);
  if (!attemptMatches) {
    logger.error('Fawaterak reports a payment whose pay_load names another attempt; not recorded as paid', {
      paymentId: payment.id,
      providerCode: code,
    });
  }
  if (Number(data.paid) === 1 && !Number.isFinite(toMinor(data.total))) {
    // An amount we cannot read is never recorded (the caller would fall back
    // to the amount expected): the outcome stays unknown and is asked again.
    throw new GatewayError('Fawaterak reports this payment paid without a total we can read.');
  }

  const payload = {
    verified: VERIFIED,
    intent_key: String(payment.providerOrderId),
    transaction_id: data.transaction_id,
    paid: Number(data.paid) === 1 ? 1 : 0,
    total: typeof data.total === 'number' || typeof data.total === 'string' ? data.total : null,
    currency: typeof data.currency === 'string' ? data.currency.slice(0, 10) : null,
    payment_method: typeof data.payment_method === 'string' ? data.payment_method.slice(0, 100) : null,
    status_text: typeof data.status_text === 'string' ? data.status_text.slice(0, 50) : null,
    attemptMatches,
  };
  return { found: true, transaction: normalizeTransaction(payload), payload };
}

/** Stage 1: never sent. Refunds are made in the merchant's Fawaterak dashboard. */
async function refund() {
  throw new GatewayRejectedError(
    'Fawaterak payments are refunded in your Fawaterak dashboard. Nothing was refunded here.'
  );
}

// ---------------------------------------------------------------- callbacks

/** Which webhook a body is, by its shape. Null for anything else. */
function webhookKind(body) {
  if (body.transaction_key !== undefined && body.status !== undefined) return 'paid';
  if (body.transaction_key !== undefined && body.errorMessage !== undefined) return 'failed';
  if (body.referenceId !== undefined) return 'cancel';
  if (body.transactionId !== undefined && body.amount !== undefined) return 'refund';
  return null;
}

const shortText = (value, max) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, max) : undefined;

/** What we keep of a webhook: never a signature, the legacy api_key, pay_load or the customer's details. */
function storableWebhook(kind, body) {
  const keep = { webhook: kind };
  for (const key of ['transaction_key', 'transaction_id', 'payment_method', 'status', 'paidAt', 'referenceNumber']) {
    const value = shortText(body[key], 100);
    if (value !== undefined) keep[key] = value;
  }
  return keep;
}

/**
 * The webhook. A body that is no Fawaterak webhook, or whose signature does
 * not verify with the vendor key, is `valid: false` (refused 401). A verified
 * cancel or refund webhook is acknowledged and dropped (null): stage 1 takes
 * card payments only and refunds in Fawaterak's dashboard. A verified paid
 * (or failed) webhook is a PENDING transaction that only names the intent:
 * the caller asks Fawaterak about it (webhookConfirmsByInquiry).
 *
 * @returns {null | { valid: boolean, eventKey, transaction, payload }}
 */
function parseWebhook({ body }, creds) {
  const refused = { valid: false, eventKey: null, transaction: null, payload: {} };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refused;
  const kind = webhookKind(body);
  if (!kind || !verifyWebhook(kind, body, creds.vendorKey)) return refused;
  if (kind === 'cancel' || kind === 'refund') return null;

  const payload = storableWebhook(kind, body);
  return {
    valid: true,
    eventKey: `wh:${kind}:${payload.transaction_key}:${payload.transaction_id}:${payload.status || ''}`,
    transaction: normalizeTransaction(payload),
    payload,
  };
}

/** The redirect back to the store carries no signature Fawaterak documents: the return page asks instead. */
function parseRedirect() {
  return null;
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
  webhookVariants,
  webhookConfirmsByInquiry: true,
  refundsInGatewayDashboard: true,
  credentialsSchema,
  settingsSchema,
  modeFromCredentials,
  availableMethods,
  connectionNotices,
  verifyCredentials,
  createPayment,
  inquire,
  refund,
  parseWebhook,
  parseRedirect,
  normalizeTransaction,
  // Exposed for tests.
  cairoDateTime,
  cardMethodOf,
  transactionNumber,
  clearTokenCache,
  VERIFIED,
  WEBHOOK_VARIANT,
};
