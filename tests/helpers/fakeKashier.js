'use strict';

// A stand-in for Kashier's API, installed with jest.spyOn on gatewayHttp.request
// so the suite never reaches the real gateway. Anything that is not a Kashier
// URL goes to whatever fake was installed before (fakePaymob), so both
// gateways can be faked at once. Also builds signed webhooks and redirects.
//
// The signer here is written independently of the adapter, from Kashier's
// published algorithm, so a test is not just the adapter agreeing with itself.

const crypto = require('crypto');
const gatewayHttp = require('../../src/modules/payments/gateways/gatewayHttp');

const MID = 'MID-123-456';
const HOSTS = {
  test: { api: 'https://test-api.kashier.io', fep: 'https://test-fep.kashier.io' },
  live: { api: 'https://api.kashier.io', fep: 'https://fep.kashier.io' },
};

function credentials(mode = 'live') {
  return {
    merchantId: MID,
    apiKey: `kashier-api-${mode}-${'d'.repeat(24)}`,
    secretKey: `kashier-secret-${mode}-${'e'.repeat(24)}`,
  };
}

const modeOfUrl = (url) => (url.startsWith(HOSTS.test.api) || url.startsWith(HOSTS.test.fep) ? 'test' : 'live');
const isKashierUrl = (url) => Object.values(HOSTS).some((h) => url.startsWith(h.api) || url.startsWith(h.fep));

function install() {
  const previous = jest.isMockFunction(gatewayHttp.request) ? gatewayHttp.request.getMockImplementation() : null;
  const state = {
    calls: [],
    sessions: [],
    // session id -> the /sessions/:id/payment `data`
    sessionPayments: new Map(),
    // our reference (merchantOrderId) -> the orders-search order
    orders: new Map(),
    // transaction id -> the aggregator transaction `body`
    transactions: new Map(),
    entitlements: { card: true, wallet: true, bank_installments: false },
    unknownMerchant: false,
    apiKeyValid: true,
    sessionStatus: 200,
    sessionLookupStatus: null,
    ordersSearchStatus: null,
    refundAnswer: null, // (body, kashierOrderId) => ({ status, json })
    nextTx: 880000,
  };

  const respond = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json) });
  const unauthorized = () => respond(401, { error: 'Authorization error', message: 'Invalid secret key' });

  const handle = (opts) => {
    const { url, body, headers = {}, method } = opts;
    const mode = modeOfUrl(url);
    const secretOk = headers.authorization === credentials(mode).secretKey;
    const path = url.replace(/^https:\/\/[^/]+/, '');

    let m = path.match(/^\/v2\/merchants\/([^/]+)\/paymentMethods$/);
    if (m) {
      if (state.unknownMerchant || decodeURIComponent(m[1]) !== MID) return respond(404, { message: 'Merchant not found' });
      return respond(200, state.entitlements);
    }
    if (path === '/v2/merchants/validate-credentials') {
      if (!secretOk) return unauthorized();
      return respond(200, { apiKeys: [{ mode, valid: state.apiKeyValid }] });
    }
    if (path.startsWith('/v3/payment/orders?')) {
      if (!secretOk) return unauthorized();
      if (state.ordersSearchStatus) return respond(state.ordersSearchStatus, { message: 'down' });
      const search = new URL(url).searchParams.get('search');
      const rows = [...state.orders.values()].filter((o) => o.merchantOrderId.toLowerCase().includes(search.toLowerCase()));
      return respond(200, { status: 'SUCCESS', data: rows, pagination: { total: rows.length, page: 1, limit: 20, pages: 1 } });
    }
    if (path === '/v3/payment/sessions' && method === 'POST') {
      if (!secretOk) return unauthorized();
      if (state.sessionStatus !== 200) return respond(state.sessionStatus, { message: 'session refused' });
      const id = crypto.randomBytes(12).toString('hex');
      state.sessions.push({ id, body, headers, mode });
      return respond(200, {
        _id: id,
        status: 'CREATED',
        merchantId: body.merchantId,
        sessionUrl: `https://payments.kashier.io/session/${id}?mode=${mode}`,
      });
    }
    m = path.match(/^\/v3\/payment\/sessions\/([^/]+)\/payment$/);
    if (m) {
      if (!secretOk) return unauthorized();
      if (state.sessionLookupStatus) return respond(state.sessionLookupStatus, { message: 'down' });
      const data = state.sessionPayments.get(m[1]);
      if (!data) return respond(404, { messages: { en: 'Payment session not found' }, status: 'FAILURE' });
      return respond(200, { message: 'success', data });
    }
    m = path.match(/^\/v2\/aggregator\/transactions\/([^/]+)$/);
    if (m) {
      if (!secretOk) return unauthorized();
      const tx = state.transactions.get(decodeURIComponent(m[1]));
      return tx ? respond(200, { body: tx }) : respond(404, { messages: { en: 'not found' }, status: 'FAILURE' });
    }
    m = path.match(/^\/v3\/orders\/([^/]+)$/);
    if (m && method === 'PUT') {
      if (!secretOk) return unauthorized();
      if (state.refundAnswer) {
        const { status, json } = state.refundAnswer(body, decodeURIComponent(m[1]));
        return respond(status, json);
      }
      state.nextTx += 1;
      const txId = `TX-${state.nextTx}`;
      return respond(200, {
        status: 'SUCCESS',
        transactionId: txId,
        response: { status: 'SUCCESS', transactionId: txId, amount: body.transaction.amount, operation: body.apiOperation.toLowerCase() },
        messages: { en: 'Congratulations! Your refund was successful' },
      });
    }
    return respond(404, { message: `unknown url ${url}` });
  };

  jest.spyOn(gatewayHttp, 'request').mockImplementation(async (opts) => {
    if (!isKashierUrl(opts.url)) {
      if (previous) return previous(opts);
      return respond(404, { message: `unknown url ${opts.url}` });
    }
    state.calls.push(opts);
    return handle(opts);
  });

  state.lastSession = () => state.sessions[state.sessions.length - 1];
  state.callsTo = (fragment) => state.calls.filter((c) => c.url.includes(fragment));

  /** Kashier's side of a paid session: the session lookup, and the order the search finds. */
  state.markPaid = (session, { amount, transactionId = `TX-${(state.nextTx += 1)}`, settled = true } = {}) => {
    const ref = session.body.order;
    const kashierOrderId = crypto.randomUUID();
    state.sessionPayments.set(session.id, {
      sessionId: session.id,
      status: 'PAID',
      merchantOrderId: ref,
      amount: amount !== undefined ? amount : session.body.amount,
      currency: session.body.currency,
      method: 'card',
      orderId: kashierOrderId,
    });
    state.orders.set(ref, {
      merchantOrderId: ref,
      orderId: kashierOrderId,
      status: 'CAPTURED',
      transactions: [
        { operation: 'pay', status: 'SUCCESS', transactionId, transactionResponseCode: 'APPROVED', isSettled: settled },
      ],
    });
    return { kashierOrderId, transactionId };
  };

  return state;
}

// ------------------------------------------------------------------ signing

/** Kashier's webhook string-to-sign: sorted signatureKeys, `k=v&...`, values RFC 3986-encoded. */
function signedString(data, keys) {
  const enc = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return [...keys]
    .sort()
    .filter((k) => data[k] !== undefined)
    .map((k) => `${k}=${enc(data[k])}`)
    .join('&');
}

function sign(data, keys, apiKey) {
  return crypto.createHmac('sha256', apiKey).update(signedString(data, keys)).digest('hex');
}

const DEFAULT_KEYS = [
  'amount',
  'channel',
  'currency',
  'kashierOrderId',
  'merchantOrderId',
  'method',
  'orderReference',
  'status',
  'transactionId',
  'transactionResponseCode',
];

/**
 * A Kashier webhook for `session` (a fake session, or anything with
 * body.order / body.amount / body.currency).
 *
 *   amount    major units, as Kashier sends it (defaults to the session's)
 *   apiKey    the key to sign with (a wrong one forges it)
 */
function webhook(
  session,
  {
    event = 'pay',
    status = 'SUCCESS',
    amount,
    transactionId = `TX-${Math.floor(Math.random() * 1e9)}`,
    kashierOrderId = 'b7d9c5c1-2f3e-4f7b-9d7e-0a1b2c3d4e5f',
    mode = 'live',
    apiKey = credentials(mode).apiKey,
    signatureKeys = DEFAULT_KEYS,
    message = status === 'SUCCESS' ? 'Approved' : 'Declined',
    tamper = null,
  } = {}
) {
  const data = {
    merchantOrderId: session.body.order,
    kashierOrderId,
    orderReference: 'TEST-ORD-33581',
    transactionId,
    status,
    method: 'card',
    creationDate: '2026-09-25T10:50:54.261Z',
    amount: amount !== undefined ? amount : Number(session.body.amount),
    currency: session.body.currency,
    card: {
      cardInfo: { cardHolderName: 'John Doe', cardBrand: 'Mastercard', maskedCard: '511111******1118' },
      merchant: { merchantRedirectURL: 'http://localhost:3001/pay' },
    },
    transactionResponseCode: status === 'SUCCESS' ? '00' : '51',
    transactionResponseMessage: { en: message, ar: message },
    channel: 'online | e-commerce',
    signatureKeys,
  };
  const signature = sign(data, signatureKeys, apiKey);
  const body = { event, data: tamper ? { ...data, ...tamper } : data };
  return { body, headers: { 'x-kashier-signature': signature } };
}

/** The shopper's redirect back: Kashier's query parameters, signed over the query string minus signature and mode. */
function redirectQuery(session, { status = 'SUCCESS', transactionId, mode = 'live', apiKey = credentials(mode).apiKey } = {}) {
  const q = {
    paymentStatus: status,
    cardDataToken: 'c2ed8287-ae57-484a-a155-8f62f63c126f',
    maskedCard: '512345******0008',
    merchantOrderId: session.body.order,
    orderId: 'a08d74e4-aab4-471f-bb73-1e02991b513b',
    cardBrand: 'Mastercard',
    orderReference: 'TEST-ORD-96353',
    transactionId: transactionId || `TX-${Math.floor(Math.random() * 1e9)}`,
    amount: session.body.amount,
    currency: session.body.currency,
  };
  const signed = Object.entries(q)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return { ...q, mode, signature: crypto.createHmac('sha256', apiKey).update(signed).digest('hex') };
}

module.exports = { install, credentials, webhook, redirectQuery, sign, signedString, MID, HOSTS, DEFAULT_KEYS };
