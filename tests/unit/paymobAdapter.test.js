'use strict';

// The Paymob adapter's pure parts: the callback signature on both callback
// shapes, and reading a transaction.

const crypto = require('crypto');
const paymob = require('../../src/modules/payments/gateways/paymob');
const fake = require('../helpers/fakePaymob');
const { redactUrl } = require('../../src/core/utils/redactUrl');

const SECRET = fake.HMAC_SECRET;

// Written out by hand from the documented field order, independently of the
// adapter's own list.
function expectedHmac(obj) {
  const s = obj.source_data;
  const text = [
    obj.amount_cents, obj.created_at, obj.currency, obj.error_occured, obj.has_parent_transaction, obj.id,
    obj.integration_id, obj.is_3d_secure, obj.is_auth, obj.is_capture, obj.is_refunded, obj.is_standalone_payment,
    obj.is_voided, obj.order.id, obj.owner, obj.pending, s.pan, s.sub_type, s.type, obj.success,
  ].join('');
  return crypto.createHmac('sha512', SECRET).update(text).digest('hex');
}

const creds = { ...fake.credentials('live') };

describe('Paymob callback signature', () => {
  const obj = fake.transaction({ id: 123, orderId: 456, amount: 25000 });

  it('covers the 20 documented fields, in order', () => {
    expect(paymob.HMAC_FIELDS).toHaveLength(20);
    expect(paymob.hmacHex(SECRET, paymob.signedStringFromTransaction(obj))).toBe(expectedHmac(obj));
  });

  it('accepts the processed callback (nested keys) and refuses a changed field', () => {
    const good = paymob.parseWebhook({ body: { type: 'TRANSACTION', obj }, query: { hmac: expectedHmac(obj) } }, creds);
    expect(good.valid).toBe(true);
    expect(good.transaction).toMatchObject({ kind: 'payment', status: 'paid', providerOrderId: '456', transactionId: '123', amount: 25000 });

    const tampered = { ...obj, success: false };
    expect(paymob.parseWebhook({ body: { type: 'TRANSACTION', obj: tampered }, query: { hmac: expectedHmac(obj) } }, creds).valid).toBe(false);
    expect(paymob.parseWebhook({ body: { type: 'TRANSACTION', obj }, query: {} }, creds).valid).toBe(false);
  });

  it('accepts the redirect (flat query) under either key spelling, with the same event key', () => {
    const q = fake.redirectQuery(obj);
    expect(q.hmac).toBe(expectedHmac(obj));
    const redirect = paymob.parseRedirect(q, creds);
    expect(redirect.valid).toBe(true);
    expect(redirect.transaction.providerOrderId).toBe('456');

    const alt = { ...q, order_id: q.order, pan: q['source_data.pan'], sub_type: q['source_data.sub_type'], type: q['source_data.type'] };
    delete alt.order;
    delete alt['source_data.pan'];
    delete alt['source_data.sub_type'];
    delete alt['source_data.type'];
    expect(paymob.parseRedirect(alt, creds).valid).toBe(true);

    const webhook = paymob.parseWebhook({ body: { type: 'TRANSACTION', obj }, query: { hmac: q.hmac } }, creds);
    expect(redirect.eventKey).toBe(webhook.eventKey);
  });

  it('ignores callbacks that are not transactions', () => {
    expect(paymob.parseWebhook({ body: { type: 'TOKEN', obj: {} }, query: {} }, creds)).toBeNull();
  });
});

describe('Paymob transactions', () => {
  it('reads payments, refunds and voids', () => {
    expect(paymob.normalizeTransaction(fake.transaction({ orderId: 1, amount: 10, success: false })).status).toBe('failed');
    expect(paymob.normalizeTransaction(fake.transaction({ orderId: 1, amount: 10, pending: true })).status).toBe('pending');
    const refund = paymob.normalizeTransaction(
      fake.transaction({ orderId: 1, amount: 10, is_refund: true, parent_transaction: 99 })
    );
    expect(refund).toMatchObject({ kind: 'refund', status: 'processed', parentTransactionId: '99' });
    expect(paymob.normalizeTransaction(fake.transaction({ orderId: 1, amount: 10, is_void: true })).kind).toBe('void');
  });

  it('reads test / live from the keys and refuses a mix', () => {
    expect(paymob.modeFromCredentials(fake.credentials('test'))).toBe('test');
    expect(paymob.modeFromCredentials(fake.credentials('live'))).toBe('live');
    expect(() =>
      paymob.modeFromCredentials({ ...fake.credentials('live'), publicKey: fake.credentials('test').publicKey })
    ).toThrow(/different modes/);
  });
});

describe('redactUrl', () => {
  it('drops signatures and webhook tokens from logged URLs', () => {
    expect(redactUrl('/api/v1/webhooks/payments/paymob/abcDEF123?hmac=deadbeef&x=1')).toBe(
      '/api/v1/webhooks/payments/paymob/[redacted]?hmac=[redacted]&x=1'
    );
    expect(redactUrl('/api/v1/webhooks/carriers/bosta/tok')).toBe('/api/v1/webhooks/carriers/bosta/[redacted]');
    expect(redactUrl('/store/x/pay?Signature=1&order=5')).toBe('/store/x/pay?Signature=[redacted]&order=5');
    expect(redactUrl('/plain/path')).toBe('/plain/path');
  });
});
