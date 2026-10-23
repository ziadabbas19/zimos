'use strict';

// The Fawaterak store adapter on its own, against the fake API. Nothing here
// touches the database.

const fawaterak = require('../../src/modules/payments/gateways/fawaterak');
const gatewayHttp = require('../../src/modules/payments/gateways/gatewayHttp');
const fake = require('../helpers/fakeFawaterakStore');

let fw;

beforeEach(() => {
  fawaterak.clearTokenCache();
  fw = fake.install();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const stored = (mode = 'live') => ({ ...fake.credentials(mode), mode });
const attempt = { id: '11111111-2222-4333-8444-555555555555', amount: '23550', currency: 'EGP' };
const order = {
  id: '99999999-2222-4333-8444-555555555555',
  orderNumber: '#1042',
  contactSnapshot: { fullName: 'Mona Ahmed Ali', phone: '01000000000' },
};
const paymentArgs = (overrides = {}) => ({
  attempt,
  order,
  method: 'card',
  settings: { cardMethodId: fake.CARD_METHOD_ID },
  returnUrl: 'https://shop.example/pay/1',
  webhookUrl: 'https://api.example/api/v1/webhooks/payments/fawaterak/tok',
  expiresInSeconds: 1800,
  locale: 'en',
  ...overrides,
});

describe('connect', () => {
  it('detects the mode from the host that accepts the OAuth client and reads the card method', async () => {
    const live = await fawaterak.verifyCredentials(fake.credentials('live'));
    expect(live).toEqual({
      mode: 'live',
      credentials: stored('live'),
      settings: { cardMethodId: fake.CARD_METHOD_ID, customerPaysFees: false },
    });
    const test = await fawaterak.verifyCredentials(fake.credentials('test'));
    expect(test.mode).toBe('test');
  });

  it('refuses a client neither host accepts', async () => {
    await expect(fawaterak.verifyCredentials({ ...fake.credentials('live'), clientSecret: 'nope-nope-nope' })).rejects.toMatchObject({
      code: 'GATEWAY_AUTH_FAILED',
    });
  });

  it('finds the card method by name, never Fawry or Meeza, and only one switched on', () => {
    expect(fawaterak.cardMethodOf(fake.DEFAULT_METHODS)).toEqual({ id: 2, customerPaysFees: false });
    expect(fawaterak.cardMethodOf([{ payment_method_id: 7, name_en: 'Visa-Mastercard', integration_status: 0 }])).toBeNull();
    expect(fawaterak.cardMethodOf([{ payment_method_id: 3, name_en: 'Fawry' }])).toBeNull();
    expect(fawaterak.cardMethodOf([{ payment_method_id: 9, name_en: 'Visa-Mastercard', commission_on_customer: 1 }])).toEqual({
      id: 9,
      customerPaysFees: true,
    });
    expect(fawaterak.cardMethodOf(null)).toBeNull();
  });

  it('keeps one token per account: two merchants never share or evict each other\'s', async () => {
    await fawaterak.verifyCredentials(fake.credentials('live'));
    await fawaterak.verifyCredentials(fake.credentials('test'));
    const before = fw.tokensIssued;
    await fawaterak.inquire(stored('live'), { payment: { id: attempt.id, providerOrderId: 'unknown' } });
    await fawaterak.inquire(stored('test'), { payment: { id: attempt.id, providerOrderId: 'unknown' } });
    expect(fw.tokensIssued).toBe(before);
  });
});

describe('two merchants with one Client ID and different secrets', () => {
  const wrong = () => ({ ...stored('live'), clientSecret: 'another-merchants-guess-0000', vendorKey: 'another-vendor-key-000000' });
  const unknownIntent = { payment: { id: attempt.id, providerOrderId: 'unknown' } };

  it('a wrong secret is refused at connect even while the right one\'s token is cached', async () => {
    await fawaterak.verifyCredentials(fake.credentials('live'));
    const { mode, ...keys } = wrong();
    const refused = await fawaterak.verifyCredentials(keys).catch((err) => err);
    expect(refused).toMatchObject({ code: 'GATEWAY_AUTH_FAILED' });
    expect(refused.message).not.toContain(keys.clientSecret);
    expect(refused.message).not.toContain(fake.credentials('live').clientSecret);
  });

  it('calls with a wrong secret never borrow the cached token, and the right keys keep theirs', async () => {
    await fawaterak.verifyCredentials(fake.credentials('live'));
    await expect(fawaterak.inquire(wrong(), unknownIntent)).rejects.toMatchObject({ code: 'GATEWAY_AUTH_FAILED' });
    const before = fw.tokensIssued;
    expect(await fawaterak.inquire(stored('live'), unknownIntent)).toEqual({ found: false });
    expect(fw.tokensIssued).toBe(before);
  });

  it('a wrong secret asking at the same moment never makes the right one fail', async () => {
    const [right, other] = await Promise.allSettled([fawaterak.inquire(stored('live'), unknownIntent), fawaterak.inquire(wrong(), unknownIntent)]);
    expect(right).toEqual({ status: 'fulfilled', value: { found: false } });
    expect(other.status).toBe('rejected');
    expect(other.reason.code).toBe('GATEWAY_AUTH_FAILED');
    // Each set of keys made its own token request.
    const secrets = fw.callsTo('/oauth/token').map((c) => c.body.client_secret);
    expect(secrets).toEqual(expect.arrayContaining([fake.credentials('live').clientSecret, wrong().clientSecret]));
  });

  it('connecting always asks Fawaterak for a new token', async () => {
    await fawaterak.verifyCredentials(fake.credentials('live'));
    const before = fw.tokensIssued;
    await fawaterak.verifyCredentials(fake.credentials('live'));
    expect(fw.tokensIssued).toBe(before + 1);
  });
});

describe('createPayment', () => {
  it('sends a direct card payment in major units and returns the card page', async () => {
    const result = await fawaterak.createPayment(stored(), paymentArgs());
    const { body } = fw.callsTo('/createTransaction')[0];
    expect(body).toMatchObject({
      payment_method_id: fake.CARD_METHOD_ID,
      cartTotal: 235.5,
      currency: 'EGP',
      customer: { first_name: 'Mona', last_name: 'Ahmed Ali', phone: '01000000000' },
      cartItems: [{ name: 'Order #1042', price: 235.5, quantity: 1 }],
      pay_load: { orderId: order.id, attemptId: attempt.id },
      tr_number: '1042-111111112222',
      lang: 'en',
      authAndCapture: 0,
    });
    expect(body.customer.email).toBeUndefined();
    expect(body.redirectionUrls.webhookUrl).toBe('https://api.example/api/v1/webhooks/payments/fawaterak/tok/paid_json');
    expect(result).toEqual({
      providerOrderId: fw.lastIntentKey(),
      providerReference: null,
      redirectUrl: `${fake.HOSTS.live}/link/${fw.lastIntentKey().slice(0, 5)}`,
    });
  });

  it('accepts the card page as data.url too, and refuses an answer with no https page or no intent', async () => {
    fw.createAnswer = () => ({ status: 200, json: { status: 'success', data: { intent_key: 'abc-key', url: 'https://app.fawaterk.com/ts/x1' } } });
    expect((await fawaterak.createPayment(stored(), paymentArgs())).redirectUrl).toBe('https://app.fawaterk.com/ts/x1');

    fw.createAnswer = () => ({ status: 200, json: { status: 'success', data: { intent_key: 'abc-key', payment_data: { redirectTo: 'http://x' } } } });
    await expect(fawaterak.createPayment(stored(), paymentArgs())).rejects.toMatchObject({ code: 'GATEWAY_ERROR' });

    fw.createAnswer = () => ({ status: 200, json: { status: 'success', data: { payment_data: { redirectTo: 'https://x.example' } } } });
    await expect(fawaterak.createPayment(stored(), paymentArgs())).rejects.toMatchObject({ code: 'GATEWAY_ERROR' });
  });

  it('a 422 is a definite refusal, a 5xx an unknown outcome, and neither echoes a key', async () => {
    fw.createAnswer = () => ({
      status: 422,
      json: { message: 'The given data was invalid.', errors: { cartTotal: [`bad total ${fake.credentials('live').clientSecret}`] } },
    });
    const refused = await fawaterak.createPayment(stored(), paymentArgs()).catch((err) => err);
    expect(refused.code).toBe('GATEWAY_REJECTED');
    expect(refused.message).not.toContain(fake.credentials('live').clientSecret);

    fw.createAnswer = () => ({ status: 503, json: { message: 'down' } });
    await expect(fawaterak.createPayment(stored(), paymentArgs())).rejects.toMatchObject({ code: 'GATEWAY_ERROR' });
  });

  it('takes card only', async () => {
    await expect(fawaterak.createPayment(stored(), paymentArgs({ method: 'wallet' }))).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
    });
    await expect(fawaterak.createPayment(stored(), paymentArgs({ settings: {} }))).rejects.toMatchObject({
      code: 'PAYMENT_METHOD_UNAVAILABLE',
    });
  });

  it('asks for a new token once when Fawaterak drops the cached one', async () => {
    await fawaterak.createPayment(stored(), paymentArgs());
    fw.tokens.clear();
    await fawaterak.createPayment(stored(), paymentArgs());
    expect(fw.callsTo('/createTransaction')).toHaveLength(3);
    expect(fw.callsTo('/oauth/token').length).toBeGreaterThanOrEqual(2);
  });

  it('due_date is Cairo local time, "Y-m-d H:i:s"', () => {
    expect(fawaterak.cairoDateTime(new Date('2026-01-15T10:00:00Z'))).toBe('2026-01-15 12:00:00');
    expect(fawaterak.cairoDateTime(new Date('2026-10-23T23:30:00Z'))).toMatch(/^2026-10-24 0[12]:30:00$/);
  });
});

describe('inquire', () => {
  async function created() {
    const result = await fawaterak.createPayment(stored(), paymentArgs());
    return { id: attempt.id, providerOrderId: result.providerOrderId };
  }

  it('paid only when Fawaterak says paid, at the total it reports, in minor units', async () => {
    const payment = await created();
    let answer = await fawaterak.inquire(stored(), { payment });
    expect(answer.transaction).toMatchObject({ kind: 'payment', status: 'pending', providerOrderId: payment.providerOrderId });

    fw.pay(payment.providerOrderId);
    answer = await fawaterak.inquire(stored(), { payment });
    expect(answer.found).toBe(true);
    expect(answer.transaction).toMatchObject({ status: 'paid', amount: 23550, currency: 'EGP', maskedDisplay: 'Visa-Mastercard' });
    expect(answer.transaction.transactionId).toBe(String(fw.intent(payment.providerOrderId).transactionId));
    // The stored payload re-normalizes to the same transaction (the sweep's retry).
    expect(fawaterak.normalizeTransaction(answer.payload)).toEqual(answer.transaction);
  });

  it('an intent Fawaterak does not know is not found; an unreadable paid total is an unknown outcome', async () => {
    expect(await fawaterak.inquire(stored(), { payment: { id: attempt.id, providerOrderId: 'nope' } })).toEqual({ found: false });
    const payment = await created();
    fw.pay(payment.providerOrderId, { total: '12,5' });
    await expect(fawaterak.inquire(stored(), { payment })).rejects.toMatchObject({ code: 'GATEWAY_ERROR' });
  });

  it('a pay_load naming another attempt never reads as paid', async () => {
    const payment = await created();
    fw.pay(payment.providerOrderId, { payLoad: JSON.stringify({ attemptId: 'someone-else' }) });
    const answer = await fawaterak.inquire(stored(), { payment });
    expect(answer.transaction.status).toBe('pending');
    expect(answer.payload.attemptMatches).toBe(false);
  });

  it('an answer about another intent is an unknown outcome', async () => {
    const payment = await created();
    fw.dataAnswer = () => ({ status: 200, json: { status: 'success', data: { intent_key: 'other', paid: 1, total: 235.5, currency: 'EGP' } } });
    await expect(fawaterak.inquire(stored(), { payment })).rejects.toMatchObject({ code: 'GATEWAY_ERROR' });
  });
});

describe('webhooks', () => {
  async function paidIntent() {
    const result = await fawaterak.createPayment(stored(), paymentArgs());
    fw.pay(result.providerOrderId);
    return result.providerOrderId;
  }

  it('a verified paid webhook is a PENDING transaction that only names the intent', async () => {
    const intentKey = await paidIntent();
    const parsed = fawaterak.parseWebhook({ body: fw.paidWebhook(intentKey) }, stored());
    expect(parsed.valid).toBe(true);
    expect(parsed.transaction).toMatchObject({ kind: 'payment', status: 'pending', providerOrderId: intentKey });
    expect(Number.isNaN(parsed.transaction.amount)).toBe(true);
    expect(Object.keys(parsed.payload)).not.toEqual(expect.arrayContaining(['transactionHashKey']));
    // A stored webhook can never re-normalize to paid.
    expect(fawaterak.normalizeTransaction({ ...parsed.payload, paid: 1, total: 235.5 }).status).toBe('pending');
  });

  it('a form-encoded body (all strings) verifies the same', async () => {
    const intentKey = await paidIntent();
    const body = fw.paidWebhook(intentKey);
    const strings = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
    expect(fawaterak.parseWebhook({ body: strings }, stored()).valid).toBe(true);
  });

  it('refuses another key, a missing signature, an edited signed field and an unknown shape', async () => {
    const intentKey = await paidIntent();
    const body = fw.paidWebhook(intentKey);
    expect(fawaterak.parseWebhook({ body: fw.paidWebhook(intentKey, { key: 'x'.repeat(30) }) }, stored()).valid).toBe(false);
    expect(fawaterak.parseWebhook({ body: { ...body, transactionHashKey: undefined } }, stored()).valid).toBe(false);
    expect(fawaterak.parseWebhook({ body: { ...body, payment_method: 'Fawry' } }, stored()).valid).toBe(false);
    expect(fawaterak.parseWebhook({ body: { hello: 1 } }, stored()).valid).toBe(false);
    expect(fawaterak.parseWebhook({ body: null }, stored()).valid).toBe(false);
    expect(fawaterak.parseWebhook({ body: [] }, stored()).valid).toBe(false);
  });

  it('the unsigned status adds nothing to the event key but paid or pending', async () => {
    const intentKey = await paidIntent();
    const keyOf = (status) => fawaterak.parseWebhook({ body: fw.paidWebhook(intentKey, { status }) }, stored()).eventKey;
    expect(keyOf('made-up-1')).toBe(keyOf('made-up-2'));
    expect(new Set([keyOf('paid'), keyOf('pending'), keyOf('made-up-1')]).size).toBe(3);
  });

  it('a verified refund webhook is acknowledged and dropped', () => {
    expect(fawaterak.parseWebhook({ body: fake.refundWebhook() }, stored())).toBeNull();
  });

  it('the redirect back is never trusted', () => {
    expect(fawaterak.parseRedirect({ transaction_key: 'x', status: 'paid' }, stored())).toBeNull();
  });
});

describe('refunds', () => {
  it('stage 1 sends none: a definite refusal that names the Fawaterak dashboard', async () => {
    const spy = jest.spyOn(gatewayHttp, 'request');
    const before = spy.mock.calls.length;
    await expect(fawaterak.refund(stored(), { payment: {}, amount: 100 })).rejects.toMatchObject({
      code: 'GATEWAY_REJECTED',
      message: expect.stringMatching(/Fawaterak dashboard/),
    });
    expect(spy.mock.calls.length).toBe(before);
  });
});
