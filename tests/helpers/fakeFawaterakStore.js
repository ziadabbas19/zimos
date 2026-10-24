'use strict';

// A stand-in for Fawaterak's API v3 as a merchant's own store gateway
// (payments/gateways/fawaterak.js): both hosts (staging = test, app = live),
// one OAuth client per account. Installed with jest.spyOn on
// gatewayHttp.request so the suite never reaches Fawaterak; anything that is
// not a Fawaterak URL goes to whatever fake was installed before.
//
// Every key here is fake. The webhook signer is written from the API
// reference's "StringToSign" line independently of
// src/modules/billing/fawaterak/signature.js, so a test is not just the code
// agreeing with itself.

const crypto = require('crypto');
const gatewayHttp = require('../../src/modules/payments/gateways/gatewayHttp');

const HOSTS = { test: 'https://staging.fawaterk.com', live: 'https://app.fawaterk.com' };

function credentials(mode = 'live') {
  return {
    clientId: `fake-oauth-client-${mode}-0000`,
    clientSecret: `fake-oauth-secret-${mode}-${'s'.repeat(20)}`,
    vendorKey: `fake-vendor-key-${mode}-${'v'.repeat(20)}`,
  };
}

const CARD_METHOD_ID = 2;

const DEFAULT_METHODS = [
  {
    payment_method_id: CARD_METHOD_ID,
    name_en: 'Visa-Mastercard',
    name_ar: 'فيزا -ماستر كارد',
    redirect: 'true',
    logo: 'https://app.fawaterk.com/clients/payment_options/mastercard-visa.png',
    commission_on_customer: 2,
    integration_status: 1,
  },
  { payment_method_id: 3, name_en: 'Fawry', name_ar: 'فوري', redirect: 'false', commission_on_customer: 2, integration_status: 1 },
  { payment_method_id: 4, name_en: 'Meeza', name_ar: 'ميزا', redirect: 'false', commission_on_customer: 1, integration_status: 1 },
];

const modeOfUrl = (url) => (url.startsWith(HOSTS.test) ? 'test' : 'live');
const isFawaterakUrl = (url) => typeof url === 'string' && Object.values(HOSTS).some((h) => url.startsWith(h));

const hmac = (text, key) => crypto.createHmac('sha256', key).update(text).digest('hex');

function install() {
  const previous = jest.isMockFunction(gatewayHttp.request) ? gatewayHttp.request.getMockImplementation() : null;
  const state = {
    calls: [],
    tokensIssued: 0,
    // token -> mode it was issued on
    tokens: new Map(),
    // intent_key -> { mode, request, paid, total, currency, transactionId, paymentMethod, payLoad }
    intents: new Map(),
    methods: DEFAULT_METHODS.map((m) => ({ ...m })),
    createAnswer: null, // (body) => ({ status, json })
    dataAnswer: null, // (intentKey) => ({ status, json })
    unreachable: false,
    nextTransactionId: 70000,
  };

  const respond = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json) });

  const handle = (opts) => {
    const { url, body = {}, headers = {}, method } = opts;
    if (state.unreachable) throw new gatewayHttp.GatewayUnreachableError('timed out');
    const mode = modeOfUrl(url);
    const host = HOSTS[mode];
    const path = url.slice(host.length);

    if (path === '/oauth/token' && method === 'POST') {
      const own = credentials(mode);
      if (body.grant_type !== 'client_credentials' || body.client_id !== own.clientId || body.client_secret !== own.clientSecret) {
        return respond(401, { error: 'invalid_client', error_description: 'Client authentication failed', message: 'Client authentication failed' });
      }
      state.tokensIssued += 1;
      const token = `fake-access-token-${mode}-${state.tokensIssued}`;
      state.tokens.set(token, mode);
      return respond(200, { token_type: 'Bearer', expires_in: 31536000, access_token: token });
    }

    const token = String(headers.authorization || '').replace(/^Bearer /, '');
    if (state.tokens.get(token) !== mode) return respond(401, { status: 'error', message: 'Unable to resolve vendor from OAuth client' });

    if (path === '/api/v3/getTrPaymentmethods' && method === 'GET') {
      return respond(200, { status: 'success', vendorSettingsData: { custome_iframe_title: null }, data: state.methods });
    }

    if (path === '/api/v3/createTransaction' && method === 'POST') {
      if (state.createAnswer) {
        const { status, json } = state.createAnswer(body);
        return respond(status, json);
      }
      const intentKey = crypto.randomUUID();
      state.intents.set(intentKey, {
        mode,
        request: body,
        paid: 0,
        total: body.cartTotal,
        currency: body.currency,
        transactionId: 0,
        paymentMethod: null,
        payLoad: body.pay_load,
      });
      return respond(200, {
        status: 'success',
        message: 'Transaction link created',
        data: { intent_key: intentKey, expires_in: 2592000, payment_data: { redirectTo: `${host}/link/${intentKey.slice(0, 5)}` } },
      });
    }

    if (path === '/api/v3/getTransactionData' && method === 'POST') {
      if (state.dataAnswer) {
        const { status, json } = state.dataAnswer(body.intent_key);
        return respond(status, json);
      }
      const intent = state.intents.get(body.intent_key);
      if (!intent || intent.mode !== mode) return respond(422, { status: 'error', message: 'Invalid intent_key or transaction not found' });
      return respond(200, {
        status: 'success',
        data: {
          intent_key: body.intent_key,
          transaction_id: intent.transactionId,
          customer_email: 'payer@example.com',
          commission: 2.5,
          paid: intent.paid,
          paid_at: intent.paid ? '2026-10-23 12:05:00' : null,
          status_text: intent.paid ? 'paid' : 'unpaid',
          total: intent.total,
          currency: intent.currency,
          payment_method: intent.paymentMethod,
          pay_load: intent.payLoad,
          transaction_history: [],
        },
      });
    }
    return respond(404, { status: 'error', message: `fake Fawaterak has no ${method} ${path}` });
  };

  jest.spyOn(gatewayHttp, 'request').mockImplementation(async (opts) => {
    if (!isFawaterakUrl(opts.url)) {
      if (previous) return previous(opts);
      return respond(404, { message: `unknown url ${opts.url}` });
    }
    state.calls.push(opts);
    return handle(opts);
  });

  state.callsTo = (fragment) => state.calls.filter((c) => c.url.includes(fragment));
  state.lastIntentKey = () => [...state.intents.keys()].pop();
  state.intent = (intentKey) => {
    const found = state.intents.get(intentKey);
    if (!found) throw new Error(`fakeFawaterakStore: no intent ${intentKey}`);
    return found;
  };

  /** The shopper paid by card: Fawaterak now reports the intent paid (with `total` / `currency` overrides). */
  state.pay = (intentKey, { total, currency, payLoad, paymentMethod = 'Visa-Mastercard' } = {}) => {
    const row = state.intent(intentKey);
    if (!row.transactionId) {
      state.nextTransactionId += 1;
      row.transactionId = state.nextTransactionId;
    }
    row.paymentMethod = paymentMethod;
    row.paid = 1;
    if (total !== undefined) row.total = total;
    if (currency !== undefined) row.currency = currency;
    if (payLoad !== undefined) row.payLoad = payLoad;
    return row;
  };

  /**
   * A signed paid webhook for `intentKey`, as Fawaterak sends it. `key` signs
   * it (another key forges it); `extra` overrides or adds unsigned fields.
   */
  state.paidWebhook = (intentKey, { status = 'paid', key, ...extra } = {}) => {
    const row = state.intent(intentKey);
    const body = {
      transaction_key: intentKey,
      transaction_id: row.transactionId || 70999,
      payment_method: row.paymentMethod || 'Visa-Mastercard',
      status,
      pay_load: JSON.stringify(row.payLoad || {}),
      paidAmount: String(row.total),
      paidCurrency: row.currency,
      paidAt: '2026-10-23 12:05:00',
      customerData: { customer_first_name: 'Fawaterak', customer_email: 'payer@example.com' },
      api_key: 'legacy-field-in-the-body',
      ...extra,
    };
    body.transactionHashKey = hmac(
      `TransactionId=${body.transaction_id}&TransactionKey=${body.transaction_key}&PaymentMethod=${body.payment_method}`,
      key || credentials(row.mode).vendorKey
    );
    return body;
  };

  return state;
}

/** A signed refund webhook (stage 1 acknowledges and drops it). */
function refundWebhook({ transactionId = 70001, amount = '50.00', currency = 'EGP', mode = 'live', key } = {}) {
  const body = { transactionId, amount, currency, status: 1, reason: 'Customer requested', approvedAt: '2026-10-23 10:15:00' };
  body.hashKey = hmac(`transactionId=${body.transactionId}&amount=${body.amount}&currency=${body.currency}`, key || credentials(mode).vendorKey);
  return body;
}

module.exports = { install, credentials, refundWebhook, hmac, HOSTS, CARD_METHOD_ID, DEFAULT_METHODS };
