'use strict';

// A stand-in for Paymob's API, installed with jest.spyOn on gatewayHttp.request
// so the suite never reaches the real gateway. Also builds signed callbacks.

const crypto = require('crypto');
const gatewayHttp = require('../../src/modules/payments/gateways/gatewayHttp');
const paymob = require('../../src/modules/payments/gateways/paymob');

const HMAC_SECRET = 'test-hmac-secret-0123456789';

function credentials(mode = 'live') {
  return {
    secretKey: `egy_sk_${mode}_${'a'.repeat(24)}`,
    publicKey: `egy_pk_${mode}_${'b'.repeat(24)}`,
    apiKey: `api_key_${'c'.repeat(24)}`,
    hmacSecret: HMAC_SECRET,
  };
}

function install() {
  paymob.clearTokenCache();
  const state = {
    calls: [],
    nextOrderId: 900000 + Math.floor(Math.random() * 1000) * 1000,
    nextTxnId: 5000000,
    intentions: [],
    // Paymob order id -> transaction obj (what inquiry answers)
    transactions: new Map(),
    // Paymob transaction id -> transaction obj (GET /transactions/:id)
    transactionsById: new Map(),
    authStatus: 201,
    intentionStatus: 201,
    inquiryStatus: null, // null = answer from `transactions`
    refundAnswer: null, // (body) => ({ status, json })
  };

  const respond = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json) });

  jest.spyOn(gatewayHttp, 'request').mockImplementation(async (opts) => {
    state.calls.push(opts);
    const { url, body } = opts;
    if (url.endsWith('/api/auth/tokens')) {
      if (state.authStatus !== 201) return respond(state.authStatus, { detail: 'Incorrect credentials' });
      return respond(201, { token: 'auth-token-xyz' });
    }
    if (url.endsWith('/v1/intention/')) {
      if (state.intentionStatus !== 201) return respond(state.intentionStatus, { detail: 'intention refused' });
      state.nextOrderId += 1;
      state.intentions.push({ body, orderId: state.nextOrderId, headers: opts.headers });
      return respond(201, {
        id: `pi_test_${state.nextOrderId}`,
        client_secret: `csk_${state.nextOrderId}`,
        intention_order_id: state.nextOrderId,
      });
    }
    if (url.endsWith('/api/ecommerce/orders/transaction_inquiry')) {
      if (state.inquiryStatus) return respond(state.inquiryStatus, { detail: 'down' });
      const txn = state.transactions.get(Number(body.order_id));
      return txn ? respond(200, txn) : respond(404, { detail: 'Not found.' });
    }
    const one = url.match(/\/api\/acceptance\/transactions\/([^/?]+)$/);
    if (one) {
      const txn = state.transactionsById.get(String(one[1]));
      return txn ? respond(200, txn) : respond(404, { detail: 'Not found.' });
    }
    if (url.endsWith('/api/acceptance/void_refund/refund')) {
      if (state.refundAnswer) {
        const { status, json } = state.refundAnswer(body);
        return respond(status, json);
      }
      state.nextTxnId += 1;
      return respond(200, transaction({
        id: state.nextTxnId,
        orderId: 1,
        amount: body.amount_cents,
        success: true,
        is_refund: true,
        parent_transaction: body.transaction_id,
      }));
    }
    return respond(404, { detail: `unknown url ${url}` });
  });

  state.lastIntention = () => state.intentions[state.intentions.length - 1];
  return state;
}

/** A Paymob transaction object, as the processed callback's `obj`. */
function transaction({
  id = 7000000 + Math.floor(Math.random() * 100000),
  orderId,
  amount,
  currency = 'EGP',
  success = true,
  pending = false,
  is_refund = false,
  is_void = false,
  parent_transaction = null,
  message = success ? 'Approved' : 'Do not honour',
}) {
  return {
    id,
    pending,
    amount_cents: amount,
    success,
    is_auth: false,
    is_capture: false,
    is_standalone_payment: true,
    is_voided: false,
    is_refunded: false,
    is_3d_secure: true,
    integration_id: 4321,
    profile_id: 99,
    has_parent_transaction: Boolean(parent_transaction),
    order: { id: orderId, merchant_order_id: 'ignored' },
    created_at: '2026-09-25T10:00:00.000000',
    currency,
    source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' },
    error_occured: false,
    is_refund,
    is_void,
    parent_transaction,
    owner: 1234,
    data: { message },
  };
}

function sign(obj, secret = HMAC_SECRET) {
  return paymob.hmacHex(secret, paymob.signedStringFromTransaction(obj));
}

/** The processed callback: body + query. */
function webhook(obj, { secret = HMAC_SECRET, hmac } = {}) {
  return { body: { type: 'TRANSACTION', obj }, query: { hmac: hmac || sign(obj, secret) } };
}

/** The shopper's redirect query string, flattened the way Paymob sends it. */
function redirectQuery(obj, secret = HMAC_SECRET) {
  const q = {
    id: String(obj.id),
    pending: String(obj.pending),
    amount_cents: String(obj.amount_cents),
    success: String(obj.success),
    is_auth: String(obj.is_auth),
    is_capture: String(obj.is_capture),
    is_standalone_payment: String(obj.is_standalone_payment),
    is_voided: String(obj.is_voided),
    is_refunded: String(obj.is_refunded),
    is_3d_secure: String(obj.is_3d_secure),
    integration_id: String(obj.integration_id),
    has_parent_transaction: String(obj.has_parent_transaction),
    order: String(obj.order.id),
    created_at: obj.created_at,
    currency: obj.currency,
    error_occured: String(obj.error_occured),
    owner: String(obj.owner),
    'source_data.pan': obj.source_data.pan,
    'source_data.type': obj.source_data.type,
    'source_data.sub_type': obj.source_data.sub_type,
    'data.message': obj.data.message,
  };
  q.hmac = paymob.hmacHex(secret, paymob.signedStringFromQuery(q));
  return q;
}

function newKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { install, credentials, transaction, sign, webhook, redirectQuery, newKey, HMAC_SECRET };
