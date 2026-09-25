'use strict';

const crypto = require('crypto');
const kashier = require('../../src/modules/payments/gateways/kashier');
const fake = require('../helpers/fakeKashier');

const creds = { ...fake.credentials('live'), mode: 'live' };
const session = { body: { order: 'ORD-1001-abc', amount: '200.00', currency: 'EGP' } };

describe('Kashier webhook signature', () => {
  it('builds exactly the string Kashier documents for its example payload', () => {
    // developers.kashier.io/docs/webhooks — the example data and its signed string.
    const data = {
      amount: 1,
      channel: 'online | e-commerce',
      currency: 'EGP',
      kashierOrderId: '9ad06b17-755b-4e21-9774-aff3e2726ac9',
      merchantOrderId: '1653481557813',
      method: 'card',
      orderReference: 'TEST-ORD-38855',
      status: 'SUCCESS',
      transactionId: 'TX-249893963',
      transactionResponseCode: '00',
    };
    const keys = [...Object.keys(data)].reverse();
    expect(kashier.signaturePayload(data, keys)).toBe(
      'amount=1&channel=online%20%7C%20e-commerce&currency=EGP&kashierOrderId=9ad06b17-755b-4e21-9774-aff3e2726ac9&merchantOrderId=1653481557813&method=card&orderReference=TEST-ORD-38855&status=SUCCESS&transactionId=TX-249893963&transactionResponseCode=00'
    );
  });

  it('encodes the characters encodeURIComponent leaves alone, as query-string does', () => {
    expect(kashier.signaturePayload({ a: "it's (ok)!*" }, ['a'])).toBe('a=it%27s%20%28ok%29%21%2A');
  });

  it('accepts a webhook signed with the Payment API key, header in any case', () => {
    const { body, headers } = fake.webhook(session);
    const parsed = kashier.parseWebhook({ body, headers }, creds);
    expect(parsed.valid).toBe(true);
    expect(parsed.transaction).toMatchObject({
      kind: 'payment',
      status: 'paid',
      providerOrderId: 'ORD-1001-abc',
      amount: 20000,
      currency: 'EGP',
      maskedDisplay: 'Mastercard •••• 1118',
    });
    expect(parsed.eventKey).toBe(`tx:${body.data.transactionId}:SUCCESS`);
    // Nothing of the card beyond its last four is kept.
    expect(JSON.stringify(parsed.payload)).not.toContain('511111');
    expect(JSON.stringify(parsed.payload)).not.toContain('John Doe');
  });

  it('rejects a forged signature', () => {
    const forged = fake.webhook(session, { apiKey: 'not-the-merchant-key-000000' });
    expect(kashier.parseWebhook(forged, creds).valid).toBe(false);
    const none = fake.webhook(session);
    expect(kashier.parseWebhook({ body: none.body, headers: {} }, creds).valid).toBe(false);
  });

  it('rejects a signed webhook whose fields were changed after signing', () => {
    const tampered = fake.webhook(session, { status: 'FAILURE', tamper: { status: 'SUCCESS' } });
    expect(kashier.parseWebhook(tampered, creds).valid).toBe(false);
  });

  it('rejects a signature that does not cover the fields we act on', () => {
    // Genuinely signed, but over a subset that leaves `amount` out: anyone
    // could have put any amount next to it.
    const keys = fake.DEFAULT_KEYS.filter((k) => k !== 'amount');
    const partial = fake.webhook(session, { signatureKeys: keys });
    expect(kashier.parseWebhook(partial, creds).valid).toBe(false);
  });

  it('drops replays and events it does not act on', () => {
    expect(kashier.parseWebhook(fake.webhook(session, { event: 'authorize' }), creds)).toBeNull();
    expect(kashier.parseWebhook(fake.webhook(session, { event: 'idempotency' }), creds)).toBeNull();
    expect(kashier.parseWebhook({ body: { event: 'pay' }, headers: {} }, creds)).toBeNull();
  });

  it('reads status, not the event name: a failed pay is a failed payment', () => {
    const parsed = kashier.parseWebhook(fake.webhook(session, { status: 'FAILURE', message: 'Insufficient funds' }), creds);
    expect(parsed.transaction.status).toBe('failed');
    expect(parsed.transaction.failureReason).toBe('Insufficient funds');
    // A card's insufficient funds is not our refund-balance code.
    expect(parsed.transaction.failureCode).toBeNull();
  });

  it('maps refund events, and flags a refund refused for balance', () => {
    const ok = kashier.parseWebhook(fake.webhook(session, { event: 'partial_refund', amount: 50 }), creds);
    expect(ok.transaction).toMatchObject({ kind: 'refund', status: 'processed', amount: 5000, parentTransactionId: null });
    const low = kashier.parseWebhook(
      fake.webhook(session, { event: 'refund', status: 'FAILURE', message: 'Insufficient available balance' }),
      creds
    );
    expect(low.transaction).toMatchObject({ kind: 'refund', status: 'failed', failureCode: 'REFUND_INSUFFICIENT_GATEWAY_BALANCE' });
  });
});

describe('Kashier redirect', () => {
  it('verifies the redirect signature and dedupes with the webhook of the same transaction', () => {
    const q = fake.redirectQuery(session, { transactionId: 'TX-42' });
    const parsed = kashier.parseRedirect(q, creds);
    expect(parsed.valid).toBe(true);
    expect(parsed.transaction).toMatchObject({ status: 'paid', providerOrderId: 'ORD-1001-abc', transactionId: 'TX-42' });
    const hook = kashier.parseWebhook(fake.webhook(session, { transactionId: 'TX-42' }), creds);
    expect(parsed.eventKey).toBe(hook.eventKey);
  });

  it('marks a tampered redirect invalid', () => {
    const q = { ...fake.redirectQuery(session, { status: 'FAILURE' }), paymentStatus: 'SUCCESS' };
    expect(kashier.parseRedirect(q, creds).valid).toBe(false);
    expect(kashier.parseRedirect({ id: '1' }, creds)).toBeNull();
  });
});

describe('Kashier amounts and references', () => {
  it('converts our minor units to decimal strings and back', () => {
    expect(kashier.toDecimal(20000)).toBe('200.00');
    expect(kashier.toDecimal(12345)).toBe('123.45');
    expect(kashier.toDecimal(5)).toBe('0.05');
    expect(kashier.toMinor(123.45)).toBe(12345);
    expect(kashier.toMinor('0.10')).toBe(10);
    expect(Number.isNaN(kashier.toMinor(undefined))).toBe(true);
  });

  it('gives each attempt its own reference, led by the order number', () => {
    const id = crypto.randomUUID();
    const ref = kashier.orderReference({ orderNumber: '#1001' }, { id });
    expect(ref).toBe(`1001-${id.replace(/-/g, '')}`);
    expect(ref.length).toBeLessThanOrEqual(100);
  });

  it('only offers the methods Kashier says the account has', () => {
    expect(kashier.availableMethods({ entitledMethods: ['card'] })).toEqual(['card']);
    expect(kashier.availableMethods({})).toEqual([]);
  });
});
