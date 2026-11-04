'use strict';

// Agent referral codes, the discount they give on subscription charges, and
// the commission ledger (migration 106).
//
// No gateway charges subscriptions yet, so a charge is created with
// subscriptionChargeService.createCharge (the seam a gateway plugs into) and
// paid through the signed billing webhook, exactly as a gateway would.

const { app, request, registerAndActivate, addMemberWithRole, addPlatformKeys, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const charges = require('../../src/modules/billing/subscriptionChargeService');
const { DEFAULT_COMMISSION_RATE_BP } = require('../../src/modules/referrals/commissionPolicy');
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

// Starter: 29900 a month / 299000 a year (10 × monthly, billing/planPricing), USD.
const STARTER_MONTHLY = 29900;
const STARTER_YEARLY = 299000;

function postWebhook(payload) {
  const raw = JSON.stringify(payload);
  return request(app)
    .post('/api/v1/billing/webhook')
    .type('json')
    .set(SIGNATURE_HEADER, signPayload(raw, TEST_SECRET))
    .send(raw);
}

const payInvoice = (invoiceId, extra = {}) => postWebhook({ type: 'invoice.paid', data: { invoiceId, ...extra } });

async function newAgent(admin, firstCode) {
  await addPlatformKeys(admin.userId, ['agents.create']);
  const person = await registerAndActivate({ fullName: 'Agent Person' });
  const res = await request(app).post('/api/v1/admin/agents').set(admin.H).send({ email: person.email, firstCode });
  if (res.status !== 201) throw new Error(`newAgent failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...person, H: { Authorization: `Bearer ${person.accessToken}` }, code: res.body.code };
}

/** A merchant whose workspace was created with `referralCode`, moved onto Starter. */
async function newMerchant(referralCode, { billingCycle = 'monthly', name = 'Referred Store' } = {}) {
  const owner = await registerAndActivate();
  const res = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name, referralCode });
  if (res.status !== 201) throw new Error(`newMerchant failed: ${res.status} ${JSON.stringify(res.body)}`);
  const starter = await db.Plan.findOne({ where: { key: 'starter' } });
  await db.Subscription.update({ planId: starter.id, billingCycle }, { where: { workspaceId: res.body.workspace.id } });
  return { owner, wid: res.body.workspace.id, H: { Authorization: `Bearer ${owner.accessToken}` } };
}

const subOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });
const ledgerFor = (wid) => db.AgentCommission.findAll({ where: { workspaceId: wid }, order: [['paidAt', 'ASC']] });

describe('referral codes: creating and editing', () => {
  it('creates an agent with a first code in one step, normalized and audited', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: ' cairo-10 ', label: 'Cairo', discountType: 'percentage', discountValue: 1000 });

    expect(agent.code).toMatchObject({
      code: 'CAIRO-10',
      label: 'Cairo',
      discountType: 'percentage',
      discountValue: 1000,
      discountCurrency: null,
      commissionRateBp: null,
      effectiveCommissionRateBp: DEFAULT_COMMISSION_RATE_BP,
      active: true,
    });
    const user = await db.User.findByPk(agent.userId);
    expect(user.platformRole).toBe('agent');
    expect(user.platformPermissions).toEqual(['referrals.view_own']);

    expect(await db.AuditLog.count({ where: { action: 'platform_admin.grant', entityId: agent.userId } })).toBe(1);
    const [codeAudit] = await db.AuditLog.findAll({ where: { action: 'referral_code.create' } });
    expect(codeAudit).toMatchObject({ actorUserId: admin.userId, workspaceId: null, metadata: { code: 'CAIRO-10' } });
  });

  it('adds more codes to an existing agent, and refuses bad or duplicate ones', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'ALEX1' });
    const add = (body, agentId = agent.userId) =>
      request(app).post(`/api/v1/admin/agents/${agentId}/codes`).set(admin.H).send(body);

    const giza = await add({ code: 'giza', label: 'Giza', discountType: 'fixed', discountValue: 5000, discountCurrency: 'usd' });
    expect(giza.status).toBe(201);
    expect(giza.body.code).toMatchObject({ code: 'GIZA', discountType: 'fixed', discountValue: 5000, discountCurrency: 'USD' });

    const dup = await add({ code: 'alex1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('REFERRAL_CODE_TAKEN');

    const invalid = [
      { code: 'no spaces' },
      { code: 'AB' },
      { code: 'PCT1', discountType: 'percentage' },
      { code: 'PCT2', discountType: 'percentage', discountValue: 10001 },
      { code: 'PCT3', discountType: 'percentage', discountValue: 500, discountCurrency: 'USD' },
      { code: 'FIX1', discountType: 'fixed', discountValue: 500 },
      { code: 'NONE1', discountType: 'none', discountValue: 500 },
      { code: 'NEG1', discountType: 'fixed', discountValue: -5, discountCurrency: 'USD' },
    ];
    for (const body of invalid) {
      const res = await add(body);
      expect([body.code, res.status]).toEqual([body.code, 422]);
    }

    // Codes belong to agents only.
    const plain = await registerAndActivate();
    const notAgent = await add({ code: 'PLAIN1' }, plain.userId);
    expect(notAgent.status).toBe(409);
    expect(notAgent.body.error.code).toBe('NOT_AN_AGENT');

    expect(await db.ReferralCode.count()).toBe(2);
  });

  it('edits and deactivates a code; the code string itself never changes', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'EDIT1', discountType: 'percentage', discountValue: 2000 });
    // Only a creator's money changes apply at once (agentCodes.test.js has the rest).
    const creator = await makePlatformUser('creator');
    const patch = (body) => request(app).patch(`/api/v1/admin/referral-codes/${agent.code.id}`).set(creator.H).send(body);

    const none = await patch({ discountType: 'none' });
    expect(none.status).toBe(200);
    expect(none.body.code).toMatchObject({ discountType: 'none', discountValue: null });

    expect((await patch({ discountType: 'fixed', discountValue: 700 })).status).toBe(422);
    const override = await patch({ commissionRateBp: 1500, label: 'Downtown' });
    expect(override.body.code).toMatchObject({ commissionRateBp: 1500, effectiveCommissionRateBp: 1500, label: 'Downtown' });

    const off = await patch({ active: false });
    expect(off.body.code.active).toBe(false);
    // `code` is not an editable field: stripped, leaving an empty patch.
    expect((await patch({ code: 'OTHER' })).status).toBe(422);
    expect((await db.ReferralCode.findByPk(agent.code.id)).code).toBe('EDIT1');

    expect(await db.AuditLog.count({ where: { action: 'referral_code.update' } })).toBe(3);
  });

  it('keeps code management away from agents', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'MINE1' });
    expect(
      (await request(app).post(`/api/v1/admin/agents/${agent.userId}/codes`).set(agent.H).send({ code: 'MINE2' })).status
    ).toBe(403);
    expect(
      (await request(app).patch(`/api/v1/admin/referral-codes/${agent.code.id}`).set(agent.H).send({ discountType: 'none' }))
        .status
    ).toBe(403);
    expect((await request(app).post('/api/v1/admin/agents').set(agent.H).send({ email: agent.email })).status).toBe(403);
  });
});

describe('merchants entering a code', () => {
  it('attaches a code typed at workspace creation, in any case, and audits it', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'START1' });
    const { wid } = await newMerchant('start1');

    const sub = await subOf(wid);
    expect(sub.referralCodeId).toBe(agent.code.id);
    expect(sub.referralCodeAttachedAt).not.toBeNull();
    const [row] = await db.AuditLog.findAll({ where: { action: 'subscription.referral_code_attach' } });
    expect(row).toMatchObject({ workspaceId: wid, afterState: { referralCode: 'START1' } });
    // The merchant can read their audit log: the agent is not named in it.
    expect(JSON.stringify(row.metadata || {})).not.toContain(agent.userId);
  });

  it('refuses an unknown or inactive code at creation without creating the workspace', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'OFF1' });
    await request(app).patch(`/api/v1/admin/referral-codes/${agent.code.id}`).set(admin.H).send({ active: false });

    const owner = await registerAndActivate();
    for (const referralCode of ['NOPE99', 'OFF1']) {
      const res = await request(app)
        .post('/api/v1/workspaces')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ name: 'Should Not Exist', referralCode });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('REFERRAL_CODE_INVALID');
    }
    expect(await db.Workspace.count()).toBe(0);
  });

  it('attaches a code later from billing, once, and shows the discount but not the agent', async () => {
    const admin = await makePlatformUser('admin');
    await newAgent(admin, { code: 'LATE1', label: 'Secret area', discountType: 'percentage', discountValue: 1500 });
    await newAgent(admin, { code: 'LATE2' });
    const { wid, H, owner } = await newMerchant(undefined);

    const attach = (code, headers = H) =>
      request(app).post(`/api/v1/workspaces/${wid}/billing/referral-code`).set(headers).send({ code });
    const first = await attach('late1');
    expect(first.status).toBe(201);
    expect(first.body.billing.referralCode).toMatchObject({ code: 'LATE1', discountType: 'percentage', discountValue: 1500 });
    expect(first.body.billing.nextCharge).toEqual({
      grossAmount: STARTER_MONTHLY,
      discountAmount: 4485,
      amount: STARTER_MONTHLY - 4485,
      currency: 'USD',
    });
    expect(JSON.stringify(first.body)).not.toContain('Secret area');

    const again = await attach('LATE1');
    expect(again.status).toBe(200);
    expect(again.body.attached).toBe(false);
    const other = await attach('LATE2');
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('REFERRAL_CODE_ALREADY_SET');

    // billing.manage: an order operator cannot.
    const operator = await addMemberWithRole(owner.accessToken, wid, 'order_operator');
    const denied = await request(app)
      .get(`/api/v1/workspaces/${wid}/billing`)
      .set('Authorization', `Bearer ${operator.accessToken}`);
    expect(denied.status).toBe(403);
  });
});

describe('the discount on each charge', () => {
  async function chargeWith(codeBody, opts) {
    const admin = await makePlatformUser('admin');
    const agent = codeBody ? await newAgent(admin, codeBody) : null;
    const merchant = await newMerchant(codeBody ? codeBody.code : undefined, opts);
    const { invoice } = await charges.createCharge(merchant.wid);
    return { admin, agent, merchant, invoice };
  }

  it('none: full price, but the code is recorded on the charge', async () => {
    const { invoice, agent } = await chargeWith({ code: 'NONE1' });
    expect(Number(invoice.grossAmount)).toBe(STARTER_MONTHLY);
    expect(Number(invoice.discountAmount)).toBe(0);
    expect(Number(invoice.amount)).toBe(STARTER_MONTHLY);
    expect(invoice.referralCodeId).toBe(agent.code.id);
    expect(invoice.status).toBe('pending');
  });

  it('percentage: basis points off the charge, rounded half-up', async () => {
    const { invoice } = await chargeWith({ code: 'PCT15', discountType: 'percentage', discountValue: 1500 });
    // 15% of 29900 = 4485.
    expect(Number(invoice.discountAmount)).toBe(4485);
    expect(Number(invoice.amount)).toBe(25415);
  });

  it('fixed: an amount off in the same currency, never below zero', async () => {
    const small = await chargeWith({ code: 'FIX50', discountType: 'fixed', discountValue: 5000, discountCurrency: 'USD' });
    expect(Number(small.invoice.discountAmount)).toBe(5000);
    expect(Number(small.invoice.amount)).toBe(STARTER_MONTHLY - 5000);

    const huge = await chargeWith({ code: 'FIX999', discountType: 'fixed', discountValue: 999999, discountCurrency: 'USD' });
    expect(Number(huge.invoice.discountAmount)).toBe(STARTER_MONTHLY);
    expect(Number(huge.invoice.amount)).toBe(0);
  });

  it('fixed: no discount on a charge in another currency, but the code still counts', async () => {
    const { invoice, agent } = await chargeWith({ code: 'EGP1', discountType: 'fixed', discountValue: 5000, discountCurrency: 'EGP' });
    expect(Number(invoice.discountAmount)).toBe(0);
    expect(Number(invoice.amount)).toBe(STARTER_MONTHLY);
    expect(invoice.referralCodeId).toBe(agent.code.id);
  });

  it('prices a yearly subscription at the yearly price', async () => {
    const { invoice } = await chargeWith({ code: 'YEAR10', discountType: 'percentage', discountValue: 1000 }, { billingCycle: 'yearly' });
    expect(Number(invoice.grossAmount)).toBe(STARTER_YEARLY);
    expect(Number(invoice.amount)).toBe(STARTER_YEARLY - 29900);
    const months = (new Date(invoice.periodEnd).getUTCFullYear() - new Date(invoice.periodStart).getUTCFullYear()) * 12;
    expect(months).toBe(12);
  });

  it('no code, or a code deactivated before the charge: full price and no code recorded', async () => {
    const plain = await chargeWith(null);
    expect(plain.invoice.referralCodeId).toBeNull();
    expect(Number(plain.invoice.amount)).toBe(STARTER_MONTHLY);

    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'GONE1', discountType: 'percentage', discountValue: 5000 });
    const merchant = await newMerchant('GONE1');
    await request(app).patch(`/api/v1/admin/referral-codes/${agent.code.id}`).set(admin.H).send({ active: false });
    const { invoice } = await charges.createCharge(merchant.wid);
    expect(invoice.referralCodeId).toBeNull();
    expect(Number(invoice.discountAmount)).toBe(0);
    // Still attached: reactivating the code brings it back for later charges.
    expect((await subOf(merchant.wid)).referralCodeId).toBe(agent.code.id);

    expect((await payInvoice(invoice.id)).body.handled).toBe(true);
    expect(await ledgerFor(merchant.wid)).toHaveLength(0);
  });

  it('keeps one open charge per subscription', async () => {
    const { merchant, invoice } = await chargeWith({ code: 'ONE1' });
    const again = await charges.createCharge(merchant.wid);
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(invoice.id);
  });
});

describe('the code is checked again when the charge is paid', () => {
  const invoiceOf = (id) => db.BillingInvoice.findByPk(id);
  const setCode = (admin, codeId, body) =>
    request(app).patch(`/api/v1/admin/referral-codes/${codeId}`).set(admin.H).send(body);

  it('active when priced and when paid: the discount and the commission stand', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'BOTH1', discountType: 'percentage', discountValue: 2000 });
    const { wid } = await newMerchant('BOTH1');
    const { invoice } = await charges.createCharge(wid);
    expect(Number(invoice.discountAmount)).toBe(5980);

    await payInvoice(invoice.id);
    const paid = await invoiceOf(invoice.id);
    expect(paid).toMatchObject({ status: 'paid', referralCodeId: agent.code.id });
    expect(Number(paid.discountAmount)).toBe(5980);
    expect(Number(paid.amount)).toBe(STARTER_MONTHLY - 5980);
    expect(Number(paid.amountPaid)).toBe(STARTER_MONTHLY - 5980);

    const [row] = await ledgerFor(wid);
    expect(row).toMatchObject({ codeId: agent.code.id, billingInvoiceId: invoice.id });
    // 30% of 23920.
    expect(Number(row.suggestedCommission)).toBe(7176);
  });

  it('active when priced but deactivated before payment: no discount and no commission', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'LAPSE1', discountType: 'percentage', discountValue: 2000 });
    const { wid } = await newMerchant('LAPSE1');
    const { invoice } = await charges.createCharge(wid);
    // Priced with the code...
    expect(invoice.referralCodeId).toBe(agent.code.id);
    expect(Number(invoice.discountAmount)).toBe(5980);

    // ...which is switched off before the payment lands.
    await setCode(admin, agent.code.id, { active: false });
    expect((await payInvoice(invoice.id)).body).toMatchObject({ handled: true, status: 'paid' });

    const paid = await invoiceOf(invoice.id);
    expect(paid.referralCodeId).toBeNull();
    expect(Number(paid.discountAmount)).toBe(0);
    expect(Number(paid.amount)).toBe(STARTER_MONTHLY);
    expect(Number(paid.amountPaid)).toBe(STARTER_MONTHLY);
    expect(await ledgerFor(wid)).toHaveLength(0);
    // The payment still counts for the subscription.
    expect((await subOf(wid)).status).toBe('active');
    // And the code stays attached for when it is switched back on.
    expect((await subOf(wid)).referralCodeId).toBe(agent.code.id);
  });

  it("applies the code's discount and rate as they stand at payment, not at pricing", async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'MOVED1', discountType: 'percentage', discountValue: 1000 });
    const { wid } = await newMerchant('MOVED1');
    const { invoice } = await charges.createCharge(wid);
    expect(Number(invoice.discountAmount)).toBe(2990);

    await setCode(await makePlatformUser('creator'), agent.code.id, { discountType: 'none', commissionRateBp: 1000 });
    await payInvoice(invoice.id);

    const paid = await invoiceOf(invoice.id);
    expect(Number(paid.discountAmount)).toBe(0);
    expect(paid.referralCodeId).toBe(agent.code.id);
    const [row] = await ledgerFor(wid);
    expect(row.commissionRateBp).toBe(1000);
    expect(Number(row.suggestedCommission)).toBe(2990);
  });

  it('does not hand a code to a charge priced without one', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'LATER1', discountType: 'percentage', discountValue: 1000 });
    const { wid } = await newMerchant('LATER1');
    await setCode(admin, agent.code.id, { active: false });
    const { invoice } = await charges.createCharge(wid);
    await setCode(admin, agent.code.id, { active: true });

    await payInvoice(invoice.id);
    const paid = await invoiceOf(invoice.id);
    expect(paid.referralCodeId).toBeNull();
    expect(Number(paid.amount)).toBe(STARTER_MONTHLY);
    expect(await ledgerFor(wid)).toHaveLength(0);
    // The next charge picks the reactivated code up.
    const next = (await charges.createCharge(wid)).invoice;
    expect(next.referralCodeId).toBe(agent.code.id);
  });

  it('works the commission out on what the gateway reports it took', async () => {
    const admin = await makePlatformUser('admin');
    await newAgent(admin, { code: 'TOOK1' });
    const { wid } = await newMerchant('TOOK1');
    const { invoice } = await charges.createCharge(wid);

    const bad = await payInvoice(invoice.id, { amountPaid: -5 });
    expect(bad.body).toMatchObject({ handled: false, reason: 'event data has an invalid amountPaid' });
    expect((await invoiceOf(invoice.id)).status).toBe('pending');

    await payInvoice(invoice.id, { amountPaid: 20000 });
    const paid = await invoiceOf(invoice.id);
    expect(Number(paid.amount)).toBe(STARTER_MONTHLY);
    expect(Number(paid.amountPaid)).toBe(20000);
    const [row] = await ledgerFor(wid);
    expect(Number(row.amountPaid)).toBe(20000);
    expect(Number(row.suggestedCommission)).toBe(6000);
  });
});

describe('the commission ledger', () => {
  it('writes a row for the first payment and for every renewal', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'LEDGER1', discountType: 'percentage', discountValue: 1000 });
    const { wid } = await newMerchant('LEDGER1');

    // First payment.
    const first = (await charges.createCharge(wid)).invoice;
    const paid = await payInvoice(first.id, { externalReference: 'gw_1' });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ handled: true, status: 'paid' });
    const sub = await subOf(wid);
    expect(sub.status).toBe('active');
    expect(new Date(sub.currentPeriodEnd).getTime()).toBe(new Date(first.periodEnd).getTime());

    // Renewal: the next period continues from the first.
    const renewal = (await charges.createCharge(wid)).invoice;
    expect(new Date(renewal.periodStart).getTime()).toBe(new Date(first.periodEnd).getTime());
    await payInvoice(renewal.id);

    const rows = await ledgerFor(wid);
    expect(rows).toHaveLength(2);
    const amount = STARTER_MONTHLY - 2990;
    for (const row of rows) {
      expect(row).toMatchObject({
        agentId: agent.userId,
        codeId: agent.code.id,
        workspaceId: wid,
        currency: 'USD',
        commissionRateBp: DEFAULT_COMMISSION_RATE_BP,
        payoutStatus: 'pending',
        payoutNote: null,
        markedPaidByAdminId: null,
        markedPaidAt: null,
      });
      expect(Number(row.amountPaid)).toBe(amount);
      // 30% of 26910 = 8073.
      expect(Number(row.suggestedCommission)).toBe(8073);
    }
    expect(rows.map((r) => r.billingInvoiceId)).toEqual([first.id, renewal.id]);
    expect(rows.map((r) => r.isFirstPayment)).toEqual([true, false]);
    expect((await db.BillingInvoice.findByPk(first.id)).externalReference).toBe('gw_1');

    // A redelivered event changes nothing.
    await payInvoice(renewal.id);
    expect(await ledgerFor(wid)).toHaveLength(2);
  });

  it("uses the code's own rate when it has one, and keeps the rate on the row", async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'RATE10', commissionRateBp: 1000 });
    const { wid } = await newMerchant('RATE10');
    await payInvoice((await charges.createCharge(wid)).invoice.id);

    const creator = await makePlatformUser('creator');
    await request(app).patch(`/api/v1/admin/referral-codes/${agent.code.id}`).set(creator.H).send({ commissionRateBp: 5000 });
    const [row] = await ledgerFor(wid);
    expect(row.commissionRateBp).toBe(1000);
    expect(Number(row.suggestedCommission)).toBe(2990);
  });

  it('writes nothing for a failed payment', async () => {
    const admin = await makePlatformUser('admin');
    await newAgent(admin, { code: 'FAIL1' });
    const { wid } = await newMerchant('FAIL1');
    const { invoice } = await charges.createCharge(wid);

    const res = await postWebhook({ type: 'invoice.payment_failed', data: { invoiceId: invoice.id, reason: 'card declined' } });
    expect(res.body).toMatchObject({ handled: true, status: 'failed' });
    expect((await subOf(wid)).status).toBe('past_due');
    expect(await ledgerFor(wid)).toHaveLength(0);

    const unknown = await payInvoice('00000000-0000-4000-8000-000000000000');
    expect(unknown.body).toMatchObject({ handled: false, reason: 'invoice not found' });
  });

  it('lets an admin mark a row paid, once, with a note; never an agent', async () => {
    const admin = await makePlatformUser('admin');
    const agent = await newAgent(admin, { code: 'PAYME' });
    const { wid } = await newMerchant('PAYME');
    await payInvoice((await charges.createCharge(wid)).invoice.id);
    const [row] = await ledgerFor(wid);
    const markPaid = (actor, body = {}) =>
      request(app).post(`/api/v1/admin/commissions/${row.id}/mark-paid`).set(actor.H).send(body);

    expect((await markPaid(agent)).status).toBe(403);

    const res = await markPaid(admin, { note: 'Bank transfer, ref 42' });
    expect(res.status).toBe(200);
    expect(res.body.commission).toMatchObject({
      id: row.id,
      payoutStatus: 'marked_paid',
      payoutNote: 'Bank transfer, ref 42',
      markedPaidBy: { id: admin.userId },
    });
    const saved = await db.AgentCommission.findByPk(row.id);
    expect(saved.markedPaidByAdminId).toBe(admin.userId);
    expect(saved.markedPaidAt).not.toBeNull();

    const again = await markPaid(admin);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('COMMISSION_ALREADY_MARKED_PAID');

    const [audit] = await db.AuditLog.findAll({ where: { action: 'agent_commission.mark_paid' } });
    expect(audit).toMatchObject({
      actorUserId: admin.userId,
      entityType: 'AgentCommission',
      entityId: row.id,
      beforeState: { payoutStatus: 'pending' },
      afterState: { payoutStatus: 'marked_paid', payoutNote: 'Bank transfer, ref 42' },
    });
  });
});

describe('agent screens', () => {
  async function twoAgentsWithPayments() {
    const admin = await makePlatformUser('admin');
    const mine = await newAgent(admin, { code: 'MINE1' });
    const theirs = await newAgent(admin, { code: 'THEIRS1' });
    const a = await newMerchant('MINE1', { name: 'My Store' });
    const b = await newMerchant('THEIRS1', { name: 'Their Store' });
    await payInvoice((await charges.createCharge(a.wid)).invoice.id);
    await payInvoice((await charges.createCharge(a.wid)).invoice.id);
    await payInvoice((await charges.createCharge(b.wid)).invoice.id);
    return { admin, mine, theirs, a, b };
  }

  it('shows an admin every agent with per-code referrals and pending / paid totals', async () => {
    const { admin, mine, a } = await twoAgentsWithPayments();
    const [first] = await ledgerFor(a.wid);
    await request(app).post(`/api/v1/admin/commissions/${first.id}/mark-paid`).set(admin.H).send({});

    const res = await request(app).get('/api/v1/admin/agents').set(admin.H);
    expect(res.status).toBe(200);
    expect(res.body.defaultCommissionRateBp).toBe(DEFAULT_COMMISSION_RATE_BP);
    expect(res.body.agents).toHaveLength(2);
    const row = res.body.agents.find((x) => x.id === mine.userId);
    expect(row.codes).toHaveLength(1);
    expect(row.codes[0]).toMatchObject({ code: 'MINE1', merchantsReferred: 1 });
    // 30% of 29900 = 8970, twice: one marked paid, one pending.
    expect(row.codes[0].commission).toEqual([
      { currency: 'USD', pending: 8970, markedPaid: 8970, amountPaid: 2 * STARTER_MONTHLY, payments: 2 },
    ]);

    const detail = await request(app).get(`/api/v1/admin/agents/${mine.userId}`).set(admin.H);
    expect(detail.body.merchants).toEqual([
      expect.objectContaining({ workspace: { id: a.wid, name: 'My Store' }, code: expect.objectContaining({ code: 'MINE1' }) }),
    ]);

    const ledger = await request(app).get(`/api/v1/admin/commissions?agentId=${mine.userId}`).set(admin.H);
    expect(ledger.body.total).toBe(2);
    expect(ledger.body.commissions[0]).toMatchObject({ workspace: { name: 'My Store' }, code: { code: 'MINE1' } });
    expect(ledger.body.totals).toEqual([
      { currency: 'USD', pending: 8970, markedPaid: 8970, amountPaid: 2 * STARTER_MONTHLY, payments: 2 },
    ]);
    const pendingOnly = await request(app).get(`/api/v1/admin/commissions?agentId=${mine.userId}&status=pending`).set(admin.H);
    expect(pendingOnly.body.total).toBe(1);
  });

  it("shows an agent only their own codes, merchants and ledger, read-only", async () => {
    const { admin, mine, a, b } = await twoAgentsWithPayments();
    const [first] = await ledgerFor(a.wid);
    await request(app).post(`/api/v1/admin/commissions/${first.id}/mark-paid`).set(admin.H).send({ note: 'Paid' });

    const view = await request(app).get('/api/v1/admin/my/referrals').set(mine.H);
    expect(view.status).toBe(200);
    expect(view.body.agent.id).toBe(mine.userId);
    expect(view.body.agent.codes.map((c) => c.code)).toEqual(['MINE1']);
    expect(view.body.merchants.map((m) => m.workspace.id)).toEqual([a.wid]);

    const ledger = await request(app).get('/api/v1/admin/my/commissions').set(mine.H);
    expect(ledger.body.total).toBe(2);
    expect(ledger.body.commissions.every((c) => c.workspace.id === a.wid)).toBe(true);
    expect(JSON.stringify(ledger.body)).not.toContain(b.wid);
    // Who paid it is another platform user's identity.
    const paidRow = ledger.body.commissions.find((c) => c.payoutStatus === 'marked_paid');
    expect(paidRow.markedPaidBy).toBeNull();
    expect(paidRow).not.toHaveProperty('agentName');

    // An agent id in the query is ignored, not honoured.
    const sneaky = await request(app).get('/api/v1/admin/my/commissions?agentId=anything').set(mine.H);
    expect(sneaky.body.total).toBe(2);

    for (const path of ['/api/v1/admin/agents', `/api/v1/admin/agents/${mine.userId}`, '/api/v1/admin/commissions']) {
      expect((await request(app).get(path).set(mine.H)).status).toBe(403);
    }
  });
});
