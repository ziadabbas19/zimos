'use strict';

// A merchant paying their subscription charge online through Fawaterak:
//
//   POST /workspaces/:workspaceId/billing/payments              the Pay button
//   GET  /workspaces/:workspaceId/billing/payments/:paymentId   the return page
//
// Fawaterak is tests/helpers/fakeFawaterak (fake keys, no network). A payment
// counts only when getTransactionData says so, for exactly the price frozen
// when Pay was pressed, and it settles the charge through the same path as a
// payment recorded by hand.

const { app, request, registerAndActivate, addPlatformKeys, approveReferralCode, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const fakeFawaterak = require('../helpers/fakeFawaterak');

const MONTHLY = 29900; // EGP 299

let fake;
let restoreConfig;

beforeEach(async () => {
  restoreConfig = fakeFawaterak.configure();
  fake = fakeFawaterak.install();
  await db.Plan.create({ key: 'eg-basic', name: 'Basic', monthlyPriceAmount: MONTHLY, yearlyPriceAmount: MONTHLY * 10, currency: 'EGP' });
  await db.Plan.create({ key: 'us-basic', name: 'Basic USD', monthlyPriceAmount: 2900, yearlyPriceAmount: 29000, currency: 'USD' });
});

afterEach(() => {
  fake.restore();
  restoreConfig();
});

async function newAgentWithCode(admin, code) {
  await addPlatformKeys(admin.userId, ['agents.create']);
  const person = await registerAndActivate({ fullName: 'Agent Person' });
  const res = await request(app).post('/api/v1/admin/agents').set(admin.H).send({ email: person.email, firstCode: code });
  if (res.status !== 201) throw new Error(`agent: ${res.status} ${JSON.stringify(res.body)}`);
  return approveReferralCode(res.body.code.id);
}

/** A merchant on `planKey`, with `referralCode` attached if given. */
async function newMerchant({ planKey = 'eg-basic', referralCode } = {}) {
  const owner = await registerAndActivate({ fullName: 'Mona Adel Hassan' });
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const res = await request(app).post('/api/v1/workspaces').set(H).send({ name: 'Paying Store', referralCode });
  if (res.status !== 201) throw new Error(`merchant: ${res.status} ${JSON.stringify(res.body)}`);
  const plan = await db.Plan.findOne({ where: { key: planKey } });
  const wid = res.body.workspace.id;
  await db.Subscription.update({ planId: plan.id }, { where: { workspaceId: wid } });
  return { wid, H, owner };
}

const payUrl = (wid) => `/api/v1/workspaces/${wid}/billing/payments`;
const statusUrl = (wid, id) => `/api/v1/workspaces/${wid}/billing/payments/${id}`;
const press = (m, body = {}) => request(app).post(payUrl(m.wid)).set(m.H).send(body);
const readStatus = (m, id) => request(app).get(statusUrl(m.wid, id)).set(m.H);
const createCalls = () => fake.state.calls.filter((c) => c.url.endsWith('/api/v3/createTransaction'));
const ageAttempts = (seconds) =>
  db.sequelize.query(`UPDATE billing_payment_attempts SET created_at = created_at - interval '${seconds} seconds', last_checked_at = NULL`);

describe('starting an online payment', () => {
  it('is off unless ONLINE_BILLING_ENABLED, and creates nothing then', async () => {
    restoreConfig();
    restoreConfig = fakeFawaterak.configure({ enabled: false });
    const m = await newMerchant();
    const billing = await request(app).get(`/api/v1/workspaces/${m.wid}/billing`).set(m.H);
    expect(billing.body.billing.onlinePayment).toEqual({ enabled: false, currency: 'EGP', latest: null });

    const res = await press(m);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ONLINE_BILLING_DISABLED');
    expect(await db.BillingInvoice.count()).toBe(0);
    expect(createCalls()).toHaveLength(0);
  });

  it('is unavailable, not broken, when a key is missing', async () => {
    restoreConfig();
    restoreConfig = fakeFawaterak.configure({ hashKey: '' });
    const m = await newMerchant();
    const billing = await request(app).get(`/api/v1/workspaces/${m.wid}/billing`).set(m.H);
    expect(billing.body.billing.onlinePayment.enabled).toBe(false);
    const res = await press(m);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ONLINE_BILLING_UNAVAILABLE');
    expect(await db.BillingInvoice.count()).toBe(0);
  });

  it('refuses a plan not priced in EGP, before pricing anything', async () => {
    const m = await newMerchant({ planKey: 'us-basic' });
    const billing = await request(app).get(`/api/v1/workspaces/${m.wid}/billing`).set(m.H);
    expect(billing.body.billing.onlinePayment.enabled).toBe(false);
    const res = await press(m);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ONLINE_PAYMENT_CURRENCY_UNSUPPORTED');
    expect(await db.BillingInvoice.count()).toBe(0);
  });

  it('prices the charge on the server and opens a hosted checkout for exactly that amount', async () => {
    const m = await newMerchant();
    const billing = await request(app).get(`/api/v1/workspaces/${m.wid}/billing`).set(m.H);
    expect(billing.body.billing.onlinePayment).toMatchObject({ enabled: true, latest: null });

    // An amount from the client is ignored.
    const res = await press(m, { lang: 'en', amount: 1, cartTotal: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      reused: false,
      payment: { status: 'open', amount: MONTHLY, currency: 'EGP', checkoutUrl: expect.stringMatching(/^https:\/\/staging\.fawaterk\.com\//) },
    });

    const invoice = await db.BillingInvoice.findOne({ where: { workspaceId: m.wid } });
    expect(invoice).toMatchObject({ status: 'pending', currency: 'EGP' });
    expect(Number(invoice.amount)).toBe(MONTHLY);

    const [call] = createCalls();
    const attemptId = res.body.payment.id;
    expect(call.body).toEqual({
      cartTotal: 299,
      currency: 'EGP',
      customer: { first_name: 'Mona', last_name: 'Adel Hassan', email: m.owner.email },
      cartItems: [{ name: 'ZIMOS Basic (monthly)', price: 299, quantity: 1 }],
      pay_load: { attemptId, billingInvoiceId: invoice.id, workspaceId: m.wid },
      redirectionUrls: {
        successUrl: expect.stringMatching(new RegExp(`/settings\\?payment=${attemptId}&workspace=${m.wid}&result=success$`)),
        failUrl: expect.stringMatching(/&result=fail$/),
        pendingUrl: expect.stringMatching(/&result=pending$/),
        backUrl: expect.stringMatching(/&result=back$/),
        webhookUrl: expect.stringMatching(new RegExp(`/api/v1/billing/fawaterak/${fakeFawaterak.FAKE_CONFIG.webhookToken}/paid_json$`)),
      },
      sendEmail: false,
      sendSMS: false,
      authAndCapture: 0,
      tr_number: attemptId,
      lang: 'en',
    });

    const attempt = await db.BillingPaymentAttempt.findByPk(attemptId);
    expect(attempt).toMatchObject({ status: 'open', provider: 'fawaterak', currency: 'EGP', providerIntentKey: fake.latestIntentKey() });
    expect(Number(attempt.amount)).toBe(MONTHLY);
    expect(attempt.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Both the charge and the start are in the merchant's own audit log.
    const actions = (await db.AuditLog.findAll({ where: { workspaceId: m.wid } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['billing_invoice.create', 'billing_payment.start']));

    const after = await request(app).get(`/api/v1/workspaces/${m.wid}/billing`).set(m.H);
    expect(after.body.billing.onlinePayment.latest).toMatchObject({ id: attemptId, status: 'open' });
  });

  it('hands back the same checkout to a second press, and a new one after a minute', async () => {
    const m = await newMerchant();
    const first = await press(m);
    const again = await press(m);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, payment: { id: first.body.payment.id } });
    expect(createCalls()).toHaveLength(1);

    await ageAttempts(61);
    const later = await press(m);
    expect(later.status).toBe(201);
    expect(later.body.payment.id).not.toBe(first.body.payment.id);
    expect((await db.BillingPaymentAttempt.findByPk(first.body.payment.id)).status).toBe('superseded');
    expect(await db.BillingInvoice.count()).toBe(1);
  });

  it('leaves the charge open when Fawaterak refuses, and a new press tries again', async () => {
    const m = await newMerchant();
    fake.state.createAnswer = () => ({ status: 422, json: { status: 'error', message: { currency: ['invalid'] } } });
    const res = await press(m);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('ONLINE_PAYMENT_START_FAILED');
    const [failed] = await db.BillingPaymentAttempt.findAll();
    expect(failed.status).toBe('error');
    expect((await db.BillingInvoice.findOne()).status).toBe('pending');

    fake.state.createAnswer = null;
    const retry = await press(m);
    expect(retry.status).toBe(201);
    expect(retry.body.payment.status).toBe('open');
  });

  it('says so when the plan is free', async () => {
    const m = await newMerchant();
    await db.Plan.update({ monthlyPriceAmount: 0, yearlyPriceAmount: 0 }, { where: { key: 'eg-basic' } });
    const res = await press(m);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_IS_FREE');
  });
});

describe('confirming a payment', () => {
  it('settles the charge only once Fawaterak says it is paid, for the frozen amount', async () => {
    const m = await newMerchant();
    const started = await press(m);
    const id = started.body.payment.id;

    const before = await readStatus(m, id);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ payment: { id, status: 'open' }, chargeStatus: 'pending' });

    const paid = fake.pay(fake.latestIntentKey());
    await ageAttempts(0);
    const after = await readStatus(m, id);
    expect(after.body).toMatchObject({ payment: { id, status: 'paid', checkoutUrl: null }, chargeStatus: 'paid' });

    const invoice = await db.BillingInvoice.findOne({ where: { workspaceId: m.wid } });
    expect(invoice).toMatchObject({ status: 'paid', paymentSource: 'gateway', externalReference: `fawaterak:${paid.transactionId}` });
    expect(Number(invoice.amountPaid)).toBe(MONTHLY);
    const subscription = await db.Subscription.findOne({ where: { workspaceId: m.wid } });
    expect(subscription.status).toBe('active');
    expect(subscription.currentPeriodEnd.getTime()).toBe(invoice.periodEnd.getTime());

    const attempt = await db.BillingPaymentAttempt.findByPk(id);
    expect(attempt).toMatchObject({ status: 'paid', verifiedCurrency: 'EGP', paymentMethod: 'Visa-Mastercard' });
    expect(Number(attempt.verifiedAmount)).toBe(MONTHLY);
    expect(Number(attempt.providerTransactionId)).toBe(paid.transactionId);
    const audit = await db.AuditLog.findOne({ where: { action: 'billing_invoice.gateway_payment' } });
    expect(audit).toMatchObject({ workspaceId: m.wid, actorUserId: null, entityId: id });
  });

  it('asks Fawaterak at most every ten seconds per attempt', async () => {
    const m = await newMerchant();
    const { id } = (await press(m)).body.payment;
    await readStatus(m, id);
    await readStatus(m, id);
    expect(fake.state.calls.filter((c) => c.url.endsWith('/getTransactionData'))).toHaveLength(1);
  });

  it('settles nothing when the paid total or currency differs', async () => {
    for (const [total, currency] of [
      [298.99, 'EGP'],
      [299, 'USD'],
      ['299.001', 'EGP'],
    ]) {
      const m = await newMerchant();
      const { id } = (await press(m)).body.payment;
      fake.pay(fake.latestIntentKey(), { total, currency });
      const res = await readStatus(m, id);
      expect(res.body).toMatchObject({ payment: { status: 'mismatch' }, chargeStatus: 'pending' });
      expect((await db.Subscription.findOne({ where: { workspaceId: m.wid } })).status).not.toBe('active');
      const attempt = await db.BillingPaymentAttempt.findByPk(id);
      expect(attempt.failureReason).toMatch(/total|currency/);
    }
    expect(await db.AuditLog.count({ where: { action: 'billing_payment.mismatch' } })).toBe(3);
  });

  it("settles nothing when the gateway's record does not name this attempt", async () => {
    const m = await newMerchant();
    const { id } = (await press(m)).body.payment;
    const row = fake.pay(fake.latestIntentKey());
    row.payLoad = { attemptId: '00000000-0000-4000-8000-000000000000' };
    const res = await readStatus(m, id);
    expect(res.body.payment.status).toBe('mismatch');
    expect(res.body.chargeStatus).toBe('pending');
  });

  it('never pays a charge twice: a payment on a charge already paid is flagged, not settled', async () => {
    const admin = await makePlatformUser('admin');
    const m = await newMerchant();
    const { id } = (await press(m)).body.payment;
    const invoice = await db.BillingInvoice.findOne({ where: { workspaceId: m.wid } });
    const manual = await request(app).post(`/api/v1/admin/charges/${invoice.id}/record-payment`).set(admin.H).send({ amountReceived: MONTHLY });
    expect(manual.status).toBe(200);
    const periodEnd = (await db.Subscription.findOne({ where: { workspaceId: m.wid } })).currentPeriodEnd.getTime();

    fake.pay(fake.latestIntentKey());
    const res = await readStatus(m, id);
    expect(res.body.payment.status).toBe('paid_duplicate');
    const settled = await db.BillingInvoice.findByPk(invoice.id);
    expect(settled.paymentSource).toBe('manual');
    expect((await db.Subscription.findOne({ where: { workspaceId: m.wid } })).currentPeriodEnd.getTime()).toBe(periodEnd);
    expect(await db.AuditLog.count({ where: { action: 'billing_payment.duplicate' } })).toBe(1);
  });

  it('keeps the price frozen at the press even when the referral code lapses before payment, without a commission', async () => {
    const admin = await makePlatformUser('admin');
    const code = await newAgentWithCode(admin, { code: 'FROZEN1', discountType: 'percentage', discountValue: 1000 });
    const m = await newMerchant({ referralCode: 'FROZEN1' });
    const started = await press(m);
    expect(started.body.payment.amount).toBe(26910);

    await db.ReferralCode.update({ active: false }, { where: { id: code.id } });
    fake.pay(fake.latestIntentKey(), { total: 269.1 });
    const res = await readStatus(m, started.body.payment.id);
    expect(res.body.payment.status).toBe('paid');

    const invoice = await db.BillingInvoice.findOne({ where: { workspaceId: m.wid } });
    expect(Number(invoice.amount)).toBe(26910);
    expect(Number(invoice.discountAmount)).toBe(2990);
    expect(Number(invoice.amountPaid)).toBe(26910);
    expect(invoice.referralCodeId).toBeNull();
    expect(await db.AgentCommission.count()).toBe(0);
    const audit = await db.AuditLog.findOne({ where: { action: 'billing_invoice.gateway_payment' } });
    expect(audit.metadata.referralCodeLapsed).toBe(true);
  });

  it('writes the commission when the code is still active at payment', async () => {
    const admin = await makePlatformUser('admin');
    await newAgentWithCode(admin, { code: 'ACTIVE1', discountType: 'percentage', discountValue: 1000 });
    const m = await newMerchant({ referralCode: 'ACTIVE1' });
    const started = await press(m);
    fake.pay(fake.latestIntentKey(), { total: '269.10' });
    await readStatus(m, started.body.payment.id);
    const commissions = await db.AgentCommission.findAll();
    expect(commissions).toHaveLength(1);
    expect(Number(commissions[0].amountPaid)).toBe(26910);
  });

  it('shows an async reference while it awaits the customer', async () => {
    const m = await newMerchant();
    const { id } = (await press(m)).body.payment;
    fake.issueReference(fake.latestIntentKey(), { reference: '981335305' });
    const res = await readStatus(m, id);
    expect(res.body.payment).toMatchObject({ status: 'pending', paymentMethod: 'Fawry', referenceNumber: '981335305' });
    expect(res.body.chargeStatus).toBe('pending');
  });

  it("answers with what it knows when Fawaterak can't be reached", async () => {
    const m = await newMerchant();
    const { id } = (await press(m)).body.payment;
    fake.state.unreachable = true;
    const res = await readStatus(m, id);
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('open');
  });

  it("never shows one store's payment to another", async () => {
    const a = await newMerchant();
    const b = await newMerchant();
    const { id } = (await press(a)).body.payment;
    expect((await readStatus(b, id)).status).toBe(404);
    expect((await request(app).get(statusUrl(a.wid, id)).set(b.H)).status).toBe(404);
  });
});
