'use strict';

// The console's subscription charges, "record payment" and "reverse payment":
//
//   GET  /admin/workspaces/:workspaceId/charges     subscriptions.view
//   POST /admin/workspaces/:workspaceId/charges     payments.record
//   POST /admin/charges/:chargeId/record-payment    payments.record
//   POST /admin/charges/:chargeId/reverse-payment   payments.record
//
// A payment recorded by hand goes through the same charge-paid path as the
// gateway webhook, so the referral code is re-checked and the commission
// ledger written exactly as for `invoice.paid`. Only a payment recorded by
// hand can be reversed.

const { app, request, registerAndActivate, addPlatformKeys, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const { signPayload, SIGNATURE_HEADER } = require('../../src/modules/billing/gatewaySignature');

const TEST_SECRET = 'test_billing_webhook_secret_0123456789';
const ORIGINAL_SECRET = env.billing.webhookSecret;

beforeEach(async () => {
  env.billing.webhookSecret = TEST_SECRET;
  await billingService.seedDefaultPlans();
});

afterAll(() => {
  env.billing.webhookSecret = ORIGINAL_SECRET;
});

function payByGateway(invoiceId) {
  const raw = JSON.stringify({ type: 'invoice.paid', data: { invoiceId } });
  return request(app)
    .post('/api/v1/billing/webhook')
    .type('json')
    .set(SIGNATURE_HEADER, signPayload(raw, TEST_SECRET))
    .send(raw);
}

// Starter: 29900 a month, USD.
const STARTER_MONTHLY = 29900;

const chargesUrl = (wid) => `/api/v1/admin/workspaces/${wid}/charges`;
const recordUrl = (chargeId) => `/api/v1/admin/charges/${chargeId}/record-payment`;
const reverseUrl = (chargeId) => `/api/v1/admin/charges/${chargeId}/reverse-payment`;
const DAY_MS = 24 * 60 * 60 * 1000;

async function newAgentWithCode(admin, code) {
  await addPlatformKeys(admin.userId, ['agents.create']);
  const person = await registerAndActivate({ fullName: 'Agent Person' });
  const res = await request(app).post('/api/v1/admin/agents').set(admin.H).send({ email: person.email, firstCode: code });
  if (res.status !== 201) throw new Error(`agent: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...person, H: { Authorization: `Bearer ${person.accessToken}` }, code: res.body.code };
}

/** A merchant on Starter, created with `referralCode` if given. */
async function newMerchant(referralCode) {
  const owner = await registerAndActivate();
  const res = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'Paying Store', referralCode });
  if (res.status !== 201) throw new Error(`merchant: ${res.status} ${JSON.stringify(res.body)}`);
  const starter = await db.Plan.findOne({ where: { key: 'starter' } });
  await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: res.body.workspace.id } });
  return res.body.workspace.id;
}

const ledgerFor = (wid) => db.AgentCommission.findAll({ where: { workspaceId: wid } });

describe('subscription charges in the console', () => {
  it('keeps charges and payments away from agents and from admins without payments.record', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgentWithCode(admin, { code: 'KEEP1' });
    const wid = await newMerchant('KEEP1');
    const created = await request(app).post(chargesUrl(wid)).set(admin.H);
    const chargeId = created.body.charge.id;

    expect((await request(app).get(chargesUrl(wid)).set(agent.H)).status).toBe(403);
    expect((await request(app).post(chargesUrl(wid)).set(agent.H)).status).toBe(403);
    expect((await request(app).post(recordUrl(chargeId)).set(agent.H).send({ amountReceived: 1 })).status).toBe(403);

    // An admin whose set a creator narrowed to viewing subscriptions.
    const viewer = await makePlatformUser('admin');
    await db.User.update({ platformPermissions: ['subscriptions.view'] }, { where: { id: viewer.userId } });
    expect((await request(app).get(chargesUrl(wid)).set(viewer.H)).status).toBe(200);
    expect((await request(app).post(recordUrl(chargeId)).set(viewer.H).send({ amountReceived: 1 })).status).toBe(403);

    expect((await db.BillingInvoice.findByPk(chargeId)).status).toBe('pending');
  });

  it('prices the next charge on request, once, and lists it with the referral code', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgentWithCode(admin, { code: 'LIST1', discountType: 'percentage', discountValue: 1000 });
    const wid = await newMerchant('LIST1');

    const before = await request(app).get(chargesUrl(wid)).set(admin.H);
    expect(before.status).toBe(200);
    expect(before.body.charges).toEqual([]);
    expect(before.body.nextCharge).toEqual({ grossAmount: STARTER_MONTHLY, discountAmount: 2990, amount: 26910, currency: 'USD' });
    expect(before.body.subscription.referralCode).toMatchObject({
      code: 'LIST1',
      active: true,
      agent: { id: agent.userId, fullName: 'Agent Person' },
    });

    const created = await request(app).post(chargesUrl(wid)).set(admin.H);
    expect(created.status).toBe(201);
    expect(created.body.charge).toMatchObject({
      status: 'pending',
      grossAmount: STARTER_MONTHLY,
      discountAmount: 2990,
      amountDue: 26910,
      amountPaid: null,
      referralCode: { code: 'LIST1' },
      payableNow: { amountDue: 26910, discountAmount: 2990, referralCodeApplies: true, codeLapsed: false },
    });
    const again = await request(app).post(chargesUrl(wid)).set(admin.H);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, charge: { id: created.body.charge.id } });

    const [audit] = await db.AuditLog.findAll({ where: { action: 'billing_invoice.create' } });
    expect(audit).toMatchObject({ actorUserId: admin.userId, entityId: created.body.charge.id, workspaceId: null });

    const after = await request(app).get(chargesUrl(wid)).set(admin.H);
    expect(after.body.charges).toHaveLength(1);
    expect(after.body.nextCharge).toBeNull();
  });

  it('records a payment by hand through the charge-paid path, with the amount actually received', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgentWithCode(admin, { code: 'HAND1', discountType: 'percentage', discountValue: 1000 });
    const wid = await newMerchant('HAND1');
    const chargeId = (await request(app).post(chargesUrl(wid)).set(admin.H)).body.charge.id;

    // 26910 was due; 25000 arrived by bank transfer.
    const res = await request(app)
      .post(recordUrl(chargeId))
      .set(admin.H)
      .send({ amountReceived: 25000, note: 'InstaPay ref 991' });
    expect(res.status).toBe(200);
    expect(res.body.referralCodeLapsed).toBe(false);
    expect(res.body.charge).toMatchObject({
      id: chargeId,
      status: 'paid',
      amountDue: 26910,
      amountPaid: 25000,
      discountAmount: 2990,
      referralCode: { code: 'HAND1' },
      paymentNote: 'InstaPay ref 991',
      recordedBy: { id: admin.userId },
      payableNow: null,
      commission: { payoutStatus: 'pending', suggestedCommission: 7500 },
    });
    expect(res.body.charge.paidAt).toBeTruthy();

    // The subscription is paid up, and the ledger row is on what arrived.
    const sub = await db.Subscription.findOne({ where: { workspaceId: wid } });
    expect(sub.status).toBe('active');
    const [row] = await ledgerFor(wid);
    expect(row).toMatchObject({ agentId: agent.userId, billingInvoiceId: chargeId, isFirstPayment: true });
    expect(Number(row.amountPaid)).toBe(25000);
    expect(Number(row.suggestedCommission)).toBe(7500);

    const [audit] = await db.AuditLog.findAll({ where: { action: 'billing_invoice.record_payment' } });
    expect(audit).toMatchObject({
      actorUserId: admin.userId,
      entityType: 'BillingInvoice',
      entityId: chargeId,
      workspaceId: null,
      beforeState: { status: 'pending', amountPaid: null },
      afterState: { status: 'paid', amount: 26910, amountPaid: 25000, paymentNote: 'InstaPay ref 991' },
      metadata: { workspaceId: wid, commissionId: row.id, referralCodeLapsed: false },
    });

    // The console list shows the result.
    const list = await request(app).get(chargesUrl(wid)).set(admin.H);
    expect(list.body.charges[0]).toMatchObject({ id: chargeId, status: 'paid', amountPaid: 25000 });

    // Recording it twice is refused, and changes nothing.
    const twice = await request(app).post(recordUrl(chargeId)).set(admin.H).send({ amountReceived: 25000 });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('CHARGE_ALREADY_PAID');
    expect(await ledgerFor(wid)).toHaveLength(1);
  });

  it('re-checks the referral code when the payment is recorded', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgentWithCode(admin, { code: 'HLAPSE', discountType: 'percentage', discountValue: 1000 });
    const wid = await newMerchant('HLAPSE');
    const chargeId = (await request(app).post(chargesUrl(wid)).set(admin.H)).body.charge.id;
    await request(app).patch(`/api/v1/admin/referral-codes/${agent.code.id}`).set(admin.H).send({ active: false });

    // The console shows the discount is gone before anyone records anything.
    const list = await request(app).get(chargesUrl(wid)).set(admin.H);
    expect(list.body.charges[0].payableNow).toEqual({
      amountDue: STARTER_MONTHLY,
      discountAmount: 0,
      referralCodeApplies: false,
      codeLapsed: true,
    });

    const res = await request(app).post(recordUrl(chargeId)).set(admin.H).send({ amountReceived: STARTER_MONTHLY });
    expect(res.status).toBe(200);
    expect(res.body.referralCodeLapsed).toBe(true);
    expect(res.body.charge).toMatchObject({
      status: 'paid',
      discountAmount: 0,
      amountDue: STARTER_MONTHLY,
      amountPaid: STARTER_MONTHLY,
      referralCode: null,
      commission: null,
    });
    expect(await ledgerFor(wid)).toHaveLength(0);
  });

  it('lets a creator record a payment on a failed charge, and validates the amount', async () => {
    const creator = await makePlatformUser('creator');
    const wid = await newMerchant(undefined);
    const chargeId = (await request(app).post(chargesUrl(wid)).set(creator.H)).body.charge.id;
    await db.BillingInvoice.update({ status: 'failed', failureReason: 'card declined' }, { where: { id: chargeId } });

    for (const body of [{}, { amountReceived: -1 }, { amountReceived: 10.5 }, { amountReceived: 'lots' }]) {
      const bad = await request(app).post(recordUrl(chargeId)).set(creator.H).send(body);
      expect([JSON.stringify(body), bad.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect((await request(app).post(recordUrl('00000000-0000-4000-8000-000000000000')).set(creator.H).send({ amountReceived: 1 })).status).toBe(404);

    const res = await request(app).post(recordUrl(chargeId)).set(creator.H).send({ amountReceived: STARTER_MONTHLY });
    expect(res.status).toBe(200);
    expect(res.body.charge).toMatchObject({ status: 'paid', failureReason: null, paymentNote: null, commission: null });
  });

  it('refuses to price a charge on a free plan', async () => {
    const admin = await makePlatformUser('admin');
    const owner = await registerAndActivate();
    const ws = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Free Store' });
    const res = await request(app).post(chargesUrl(ws.body.workspace.id)).set(admin.H);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_IS_FREE');
  });
});

describe('the date a payment recorded by hand arrived', () => {
  it('stores an explicit past date as the payment date, on the charge and in the agent ledger', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgentWithCode(admin, { code: 'DATED1' });
    const wid = await newMerchant('DATED1');
    const chargeId = (await request(app).post(chargesUrl(wid)).set(admin.H)).body.charge.id;

    const arrived = new Date(Date.now() - 6 * DAY_MS);
    arrived.setUTCHours(10, 0, 0, 0);
    const before = Date.now();
    const res = await request(app)
      .post(recordUrl(chargeId))
      .set(admin.H)
      .send({ amountReceived: STARTER_MONTHLY, paidAt: arrived.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.charge).toMatchObject({ status: 'paid', paymentSource: 'manual', paidAt: arrived.toISOString() });
    // Recorded now, dated when the money arrived.
    expect(new Date(res.body.charge.paymentRecordedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

    const [row] = await ledgerFor(wid);
    expect(new Date(row.paidAt).toISOString()).toBe(arrived.toISOString());
    // The agent sees the payment date, not the recording date.
    const mine = await request(app).get('/api/v1/admin/my/commissions').set(agent.H);
    expect(mine.body.commissions[0].paidAt).toBe(arrived.toISOString());
  });

  it('defaults to now when no date is given, and refuses a date in the future', async () => {
    const admin = await makePlatformUser('admin');
    const wid = await newMerchant(undefined);
    const chargeId = (await request(app).post(chargesUrl(wid)).set(admin.H)).body.charge.id;

    const future = await request(app)
      .post(recordUrl(chargeId))
      .set(admin.H)
      .send({ amountReceived: STARTER_MONTHLY, paidAt: new Date(Date.now() + 2 * DAY_MS).toISOString() });
    expect(future.status).toBe(422);
    expect((await request(app).post(recordUrl(chargeId)).set(admin.H).send({ amountReceived: 1, paidAt: 'soon' })).status).toBe(422);

    const before = Date.now();
    const res = await request(app).post(recordUrl(chargeId)).set(admin.H).send({ amountReceived: STARTER_MONTHLY, paidAt: '' });
    expect(res.status).toBe(200);
    const paidAt = new Date(res.body.charge.paidAt).getTime();
    expect(paidAt).toBeGreaterThanOrEqual(before - 1000);
    expect(paidAt).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('reversing a payment recorded by hand', () => {
  async function paidByHand(opts = {}) {
    const admin = await makePlatformUser('admin');
    const agent = await newAgentWithCode(admin, { code: opts.code || 'UNDO1' });
    const wid = await newMerchant(opts.code || 'UNDO1');
    const chargeId = (await request(app).post(chargesUrl(wid)).set(admin.H)).body.charge.id;
    await request(app)
      .post(recordUrl(chargeId))
      .set(admin.H)
      .send({ amountReceived: STARTER_MONTHLY, note: 'Bank transfer', paidAt: new Date(Date.now() - 2 * DAY_MS).toISOString() });
    return { admin, agent, wid, chargeId };
  }

  it('puts the charge back to pending, voids its ledger row and audits it; the subscription is left alone', async () => {
    const { admin, agent, wid, chargeId } = await paidByHand();
    const [liveRow] = await ledgerFor(wid);
    const subBefore = await db.Subscription.findOne({ where: { workspaceId: wid } });

    const res = await request(app).post(reverseUrl(chargeId)).set(admin.H).send({ reason: 'Transfer bounced' });
    expect(res.status).toBe(200);
    expect(res.body.voidedCommission).toMatchObject({ id: liveRow.id, payoutStatus: 'pending' });
    expect(res.body.charge).toMatchObject({
      id: chargeId,
      status: 'pending',
      paidAt: null,
      amountPaid: null,
      paymentNote: null,
      recordedBy: null,
      paymentSource: null,
      paymentRecordedAt: null,
      commission: null,
    });

    // The ledger row is kept, voided, and no longer counts anywhere.
    const voided = await db.AgentCommission.findByPk(liveRow.id);
    expect(voided).toMatchObject({ voidedByAdminId: admin.userId, voidReason: 'Transfer bounced', payoutStatus: 'pending' });
    expect(voided.voidedAt).not.toBeNull();
    const ledger = await request(app).get(`/api/v1/admin/commissions?agentId=${agent.userId}`).set(admin.H);
    expect(ledger.body.totals).toEqual([]);
    expect(ledger.body.commissions[0]).toMatchObject({ id: liveRow.id, voidReason: 'Transfer bounced', voidedBy: { id: admin.userId } });
    expect((await request(app).get(`/api/v1/admin/commissions?agentId=${agent.userId}&status=pending`).set(admin.H)).body.total).toBe(0);
    expect((await request(app).get(`/api/v1/admin/commissions?agentId=${agent.userId}&status=voided`).set(admin.H)).body.total).toBe(1);
    const agents = await request(app).get('/api/v1/admin/agents').set(admin.H);
    expect(agents.body.agents[0].commission).toEqual([]);

    const [audit] = await db.AuditLog.findAll({ where: { action: 'billing_invoice.reverse_payment' } });
    expect(audit).toMatchObject({
      actorUserId: admin.userId,
      entityType: 'BillingInvoice',
      entityId: chargeId,
      workspaceId: null,
      beforeState: { status: 'paid', paymentSource: 'manual', amountPaid: STARTER_MONTHLY, paymentNote: 'Bank transfer', recordedByUserId: admin.userId },
      afterState: { status: 'pending', paidAt: null, amountPaid: null, paymentSource: null, recordedByUserId: null },
      metadata: { workspaceId: wid, reason: 'Transfer bounced', voidedCommissionId: liveRow.id, voidedCommissionWasPaidOut: false },
    });

    // The payment had made the subscription active, so the reversal makes it
    // past_due; its period fields are not touched.
    const subAfter = await db.Subscription.findOne({ where: { workspaceId: wid } });
    expect(subBefore.status).toBe('active');
    expect(subAfter.status).toBe('past_due');
    expect(new Date(subAfter.currentPeriodEnd).getTime()).toBe(new Date(subBefore.currentPeriodEnd).getTime());
    expect(res.body.subscriptionStatus).toEqual({ from: 'active', to: 'past_due' });

    // Recording the payment again writes a fresh live row beside the voided one.
    const again = await request(app).post(recordUrl(chargeId)).set(admin.H).send({ amountReceived: STARTER_MONTHLY });
    expect(again.status).toBe(200);
    expect(again.body.charge.commission).toMatchObject({ payoutStatus: 'pending' });
    const rows = await ledgerFor(wid);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.voidedAt === null)).toHaveLength(1);
  });

  it('moves the subscription to past_due; paying the reopened charge makes it active exactly as any payment', async () => {
    const { admin, wid, chargeId } = await paidByHand({ code: 'PDUE1' });
    const charge = await db.BillingInvoice.findByPk(chargeId);
    expect(charge.subscriptionBeforePayment).toMatchObject({ status: 'trialing' });

    const res = await request(app).post(reverseUrl(chargeId)).set(admin.H).send({});
    expect(res.body.subscriptionStatus).toEqual({ from: 'active', to: 'past_due' });
    expect((await db.Subscription.findOne({ where: { workspaceId: wid } })).status).toBe('past_due');
    const [audit] = await db.AuditLog.findAll({ where: { action: 'billing_invoice.reverse_payment' } });
    expect(audit.metadata.subscriptionStatus).toEqual({ from: 'active', to: 'past_due' });

    // The same charge is open and payable again; paying it is a normal payment.
    const list = await request(app).get(chargesUrl(wid)).set(admin.H);
    expect(list.body.charges[0]).toMatchObject({ id: chargeId, status: 'pending' });
    const again = await request(app).post(recordUrl(chargeId)).set(admin.H).send({ amountReceived: STARTER_MONTHLY });
    expect(again.status).toBe(200);
    const sub = await db.Subscription.findOne({ where: { workspaceId: wid } });
    expect(sub.status).toBe('active');
    expect(new Date(sub.currentPeriodEnd).getTime()).toBe(new Date(charge.periodEnd).getTime());
    expect((await db.BillingInvoice.findByPk(chargeId)).subscriptionBeforePayment).toMatchObject({ status: 'past_due' });
  });

  it('leaves a subscription already past_due or cancelled for another reason as it is', async () => {
    const { admin, wid, chargeId } = await paidByHand({ code: 'OTHER1' });
    // A failure reported for the workspace after the payment.
    await db.Subscription.update({ status: 'past_due' }, { where: { workspaceId: wid } });

    const res = await request(app).post(reverseUrl(chargeId)).set(admin.H).send({});
    expect(res.status).toBe(200);
    expect(res.body.subscriptionStatus).toEqual({ from: 'past_due', to: 'past_due' });
    expect((await db.Subscription.findOne({ where: { workspaceId: wid } })).status).toBe('past_due');

    // Same for one cancelled in the meantime.
    await request(app).post(recordUrl(chargeId)).set(admin.H).send({ amountReceived: STARTER_MONTHLY });
    await db.Subscription.update({ status: 'cancelled' }, { where: { workspaceId: wid } });
    const again = await request(app).post(reverseUrl(chargeId)).set(admin.H).send({});
    expect(again.status).toBe(200);
    expect((await db.Subscription.findOne({ where: { workspaceId: wid } })).status).toBe('cancelled');
  });

  it('leaves a subscription active when it was already active before the reversed payment', async () => {
    const { admin, wid } = await paidByHand({ code: 'EARLY1' });
    // The next period's charge, paid (by mistake) while the current one runs.
    const renewalId = (await request(app).post(chargesUrl(wid)).set(admin.H)).body.charge.id;
    await request(app).post(recordUrl(renewalId)).set(admin.H).send({ amountReceived: STARTER_MONTHLY });
    expect((await db.BillingInvoice.findByPk(renewalId)).subscriptionBeforePayment).toMatchObject({ status: 'active' });

    const res = await request(app).post(reverseUrl(renewalId)).set(admin.H).send({});
    expect(res.status).toBe(200);
    expect(res.body.subscriptionStatus).toEqual({ from: 'active', to: 'active' });
    expect((await db.Subscription.findOne({ where: { workspaceId: wid } })).status).toBe('active');
  });

  it('keeps a row that was already paid out, voided, and refuses to mark a voided row paid', async () => {
    const { admin, wid, chargeId } = await paidByHand({ code: 'OUT1' });
    const [row] = await ledgerFor(wid);
    await request(app).post(`/api/v1/admin/commissions/${row.id}/mark-paid`).set(admin.H).send({}).expect(200);

    const res = await request(app).post(reverseUrl(chargeId)).set(admin.H).send({});
    expect(res.status).toBe(200);
    expect(res.body.voidedCommission).toMatchObject({ id: row.id, payoutStatus: 'marked_paid' });
    const kept = await db.AgentCommission.findByPk(row.id);
    expect(kept.payoutStatus).toBe('marked_paid');
    expect(kept.voidReason).toBe('Payment reversed');
    const [audit] = await db.AuditLog.findAll({ where: { action: 'billing_invoice.reverse_payment' } });
    expect(audit.metadata).toMatchObject({ reason: null, voidedCommissionWasPaidOut: true });

    // A fresh pending row (after paying again) is fine; the voided one can't be marked.
    await request(app).post(recordUrl(chargeId)).set(admin.H).send({ amountReceived: STARTER_MONTHLY });
    const voidedAgain = await request(app).post(`/api/v1/admin/commissions/${row.id}/mark-paid`).set(admin.H).send({});
    expect(voidedAgain.status).toBe(409);
    expect(voidedAgain.body.error.code).toBe('COMMISSION_VOIDED');
  });

  it('refuses to reverse a charge that is not paid', async () => {
    const admin = await makePlatformUser('admin');
    const wid = await newMerchant(undefined);
    const chargeId = (await request(app).post(chargesUrl(wid)).set(admin.H)).body.charge.id;
    const res = await request(app).post(reverseUrl(chargeId)).set(admin.H).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHARGE_NOT_PAID');
    expect(await db.AuditLog.count({ where: { action: 'billing_invoice.reverse_payment' } })).toBe(0);
    expect((await request(app).post(reverseUrl('00000000-0000-4000-8000-000000000000')).set(admin.H).send({})).status).toBe(404);
  });

  it('refuses to reverse a payment the gateway confirmed, with its own error code', async () => {
    const admin = await makePlatformUser('admin');
    await newAgentWithCode(admin, { code: 'GATE1' });
    const wid = await newMerchant('GATE1');
    const chargeId = (await request(app).post(chargesUrl(wid)).set(admin.H)).body.charge.id;
    expect((await payByGateway(chargeId)).body).toMatchObject({ handled: true, status: 'paid' });

    const charge = await db.BillingInvoice.findByPk(chargeId);
    expect(charge).toMatchObject({ paymentSource: 'gateway', recordedByUserId: null, paymentRecordedAt: null });

    const res = await request(app).post(reverseUrl(chargeId)).set(admin.H).send({ reason: 'oops' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_CONFIRMED_BY_GATEWAY');
    expect((await db.BillingInvoice.findByPk(chargeId)).status).toBe('paid');
    const [row] = await ledgerFor(wid);
    expect(row.voidedAt).toBeNull();
  });

  it('refuses while another charge is open, and keeps reversal away from agents', async () => {
    const { admin, agent, wid, chargeId } = await paidByHand({ code: 'OPEN1' });
    expect((await request(app).post(reverseUrl(chargeId)).set(agent.H).send({})).status).toBe(403);

    // The next period's charge is already open.
    expect((await request(app).post(chargesUrl(wid)).set(admin.H)).status).toBe(201);
    const res = await request(app).post(reverseUrl(chargeId)).set(admin.H).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPEN_CHARGE_EXISTS');
    expect((await db.BillingInvoice.findByPk(chargeId)).status).toBe('paid');
  });
});
