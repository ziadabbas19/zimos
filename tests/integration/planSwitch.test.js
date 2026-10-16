'use strict';

// A merchant changing plan by themselves (billing/planSwitchService,
// PLAN_SWITCH_ENABLED, migration 702):
//
//   POST /workspaces/:id/billing/plan-switch/preview | /plan-switch | /plan-switch/cancel
//   billing job: billing.plan_switches (planSwitchService.runDue)
//
// An upgrade "now" pays the new plan's full price and starts a full period
// once paid; "period_end" waits for the end of the paid period, then a
// renewal at the new price is written. A downgrade, and a move to pay per
// order, wait for the end of the paid period; an ended period changes at
// once. Paid by a transfer's proof, online (Fawaterak, faked) or by the
// console; voided when cancelled, replaced, left unpaid or not paid.

const sharp = require('sharp');
const { app, request, setupWorkspaceWithProduct, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const fakeFawaterak = require('../helpers/fakeFawaterak');
const switches = require('../../src/modules/billing/planSwitchService');
const charges = require('../../src/modules/billing/subscriptionChargeService');
const { accessFor } = require('../../src/modules/workspaces/workspaceAccessService');

const DAY = 24 * 60 * 60 * 1000;
const BASIC = 30000;
const PRO = 60000;
const BUSINESS = 90000;

let basic;
let pro;
let business;
let free;
let usdBasic;
let usdPro;
let admin;

beforeEach(async () => {
  env.billing.planSwitch.enabled = true;
  basic = await db.Plan.create({ key: 'basic', name: 'Basic', monthlyPriceAmount: BASIC, yearlyPriceAmount: BASIC * 10, currency: 'EGP', isPublic: true, isActive: true });
  pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: PRO, yearlyPriceAmount: PRO * 10, currency: 'EGP', isPublic: true, isActive: true });
  business = await db.Plan.create({ key: 'business', name: 'Business', monthlyPriceAmount: BUSINESS, yearlyPriceAmount: BUSINESS * 10, currency: 'EGP', isPublic: true, isActive: true });
  free = await db.Plan.create({ key: 'free', name: 'Free', monthlyPriceAmount: 0, yearlyPriceAmount: 0, currency: 'EGP', isPublic: true, isActive: true });
  usdBasic = await db.Plan.create({ key: 'usd-basic', name: 'Basic USD', monthlyPriceAmount: 2000, yearlyPriceAmount: 20000, currency: 'USD', isPublic: true, isActive: true });
  usdPro = await db.Plan.create({ key: 'usd-pro', name: 'Pro USD', monthlyPriceAmount: 5000, yearlyPriceAmount: 50000, currency: 'USD', isPublic: true, isActive: true });
  await db.PaymentMethod.create({ kind: 'manual', code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10, enabled: true, accountNumber: 'zimos@instapay' });
  admin = await makePlatformUser('creator');
});

afterEach(() => {
  env.billing.planSwitch.enabled = false;
});

/** A store on `plan`, its thirty-day period paid, `daysLeft` of it to go (negative: ended). */
async function paidStore(plan = basic, { daysLeft = 20, status = 'active' } = {}) {
  const setup = await setupWorkspaceWithProduct({ stock: 1 });
  const wid = setup.workspace.id;
  const H = { Authorization: `Bearer ${setup.auth.accessToken}` };
  const end = new Date(Date.now() + daysLeft * DAY);
  const start = new Date(end.getTime() - 30 * DAY);
  await db.Subscription.update(
    { planId: plan.id, status, billingCycle: 'monthly', currentPeriodStart: start, currentPeriodEnd: end, trialEndsAt: null },
    { where: { workspaceId: wid } }
  );
  const subscription = await db.Subscription.findOne({ where: { workspaceId: wid } });
  const price = Number(plan.monthlyPriceAmount);
  if (price > 0) {
    await db.BillingInvoice.create({
      workspaceId: wid, subscriptionId: subscription.id, grossAmount: price, amount: price, amountPaid: price,
      currency: plan.currency, status: 'paid', paymentSource: 'manual', paidAt: start, periodStart: start, periodEnd: end,
    });
  }
  return { wid, H, end };
}

const url = (s, path) => `/api/v1/workspaces/${s.wid}/billing${path}`;
const preview = (s, body) => request(app).post(url(s, '/plan-switch/preview')).set(s.H).send(body);
const start = (s, body) => request(app).post(url(s, '/plan-switch')).set(s.H).send(body);
const cancel = (s) => request(app).post(url(s, '/plan-switch/cancel')).set(s.H).send({});
const plansOf = (s) => request(app).get(url(s, '/plans')).set(s.H);
const subscriptionOf = (s) => db.Subscription.findOne({ where: { workspaceId: s.wid } });
const pendingOf = (s) => db.BillingInvoice.findAll({ where: { workspaceId: s.wid, status: 'pending' } });
const openOf = (s) => db.PlanSwitch.findAll({ where: { workspaceId: s.wid, status: ['pending', 'scheduled'] } });
const approve = (proofId, receivedAmount) => request(app).post(`/api/v1/admin/payment-proofs/${proofId}/approve`).set(admin.H).send({ receivedAmount });
const recordPayment = (id, amount) => request(app).post(`/api/v1/admin/charges/${id}/record-payment`).set(admin.H).send({ amountReceived: amount });

let shade = 0;
async function proof(s, invoiceId) {
  shade += 1;
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: shade % 256, g: 90, b: 40 } } }).png().toBuffer();
  return request(app)
    .post(url(s, `/invoices/${invoiceId}/payment-proofs`))
    .set(s.H)
    .field('methodCode', 'instapay')
    .field('senderPhone', '01012345678')
    .attach('file', png, { filename: 'shot.png', contentType: 'image/png' });
}

describe('with PLAN_SWITCH_ENABLED off', () => {
  it('everything is as before: no preview, no start, support for a paid plan; cancelling finds nothing', async () => {
    env.billing.planSwitch.enabled = false;
    const s = await paidStore();
    expect((await preview(s, { planId: pro.id })).status).toBe(404);
    const refused = await start(s, { planId: pro.id });
    expect(refused.status).toBe(404);
    expect(refused.body.error.code).toBe('PLAN_SWITCH_DISABLED');
    const old = await request(app).post(url(s, '/plan')).set(s.H).send({ planId: pro.id });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('PLAN_CHANGE_NEEDS_SUPPORT');
    const plans = await plansOf(s);
    expect(plans.body).toMatchObject({ planChange: 'support', planSwitch: { enabled: false, mode: null, open: null } });
    expect((await cancel(s)).body).toMatchObject({ cancelled: false });
    expect(await db.BillingInvoice.count({ where: { workspaceId: s.wid, status: 'pending' } })).toBe(0);
  });
});

describe('an upgrade in the middle of a paid period', () => {
  it('previews the full price now or nothing until the period ends, starts one charge, and switches once a transfer is approved: a full period from then', async () => {
    const s = await paidStore();
    const shown = await preview(s, { planId: pro.id });
    expect(shown.status).toBe(200);
    expect(shown.body.preview).toMatchObject({
      kind: 'upgrade',
      reason: 'upgrade',
      timing: 'now',
      timings: ['now', 'period_end'],
      effective: 'on_payment',
      amountDue: PRO,
      currency: 'EGP',
      proration: null,
      currentPeriod: { remainingDays: 20 },
      nextRenewal: { at: null, amount: PRO, billingCycle: 'monthly' },
      options: { now: { amountDue: PRO, payable: true }, period_end: { effective: 'period_end', amountDue: 0, chargeExpiry: null } },
      payable: true,
      blockedBy: null,
    });
    expect(new Date(shown.body.preview.currentPeriod.endsAt).getTime()).toBe(s.end.getTime());
    expect(new Date(shown.body.preview.options.period_end.effectiveAt).getTime()).toBe(s.end.getTime());
    expect(await db.BillingInvoice.count({ where: { workspaceId: s.wid, status: 'pending' } })).toBe(0);

    const started = await start(s, { planId: pro.id, timing: 'now', expectedAmount: PRO });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ kind: 'upgrade', created: true, invoice: { status: 'pending', amountDue: PRO, targetPlanId: pro.id } });
    expect(started.body.plans.planSwitch).toMatchObject({ enabled: true, mode: 'switch', open: { kind: 'upgrade', status: 'pending', amountDue: PRO, timing: 'now', proration: null } });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);

    // The usual Pay dialog finds it.
    const opened = await request(app).post(url(s, '/invoices/open')).set(s.H).send({});
    expect(opened.body).toMatchObject({ written: true, invoice: { id: started.body.invoice.id, amountDue: PRO } });

    const sent = await proof(s, started.body.invoice.id);
    expect(sent.status).toBe(201);
    const approvedAt = Date.now();
    expect((await approve(sent.body.proof.id, PRO)).status).toBe(200);

    // The old period is closed: a full month of Pro from the payment.
    const after = await subscriptionOf(s);
    expect(after).toMatchObject({ planId: pro.id, status: 'active', billingCycle: 'monthly' });
    expect(after.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(approvedAt - 1000);
    const length = after.currentPeriodEnd.getTime() - after.currentPeriodStart.getTime();
    expect(length).toBeGreaterThanOrEqual(28 * DAY);
    expect(length).toBeLessThanOrEqual(31 * DAY);
    expect(await db.PlanSwitch.findOne({ where: { workspaceId: s.wid } })).toMatchObject({ status: 'applied' });
    // The next renewal is the new plan's full price, from the end of that period.
    const next = await request(app).post(url(s, '/invoices/open')).set(s.H).send({});
    expect(next.body.invoice).toMatchObject({ id: 'next', amountDue: PRO });
    expect(new Date(next.body.invoice.periodStart).getTime()).toBe(after.currentPeriodEnd.getTime());
  });

  it('the preview says how long the charge would live, and the switch started lives that long', async () => {
    const s = await paidStore();
    const hours = env.billing.planSwitch.chargeExpiryHours;
    const before = Date.now();
    const shown = await preview(s, { planId: pro.id });
    expect(shown.body.preview.chargeExpiry).toMatchObject({ hours });
    const lives = new Date(shown.body.preview.chargeExpiry.expiresAt).getTime() - before;
    expect(lives).toBeGreaterThanOrEqual(hours * 3600 * 1000);
    expect(lives).toBeLessThan(hours * 3600 * 1000 + 60 * 1000);
    const started = await start(s, { planId: pro.id });
    const { expiresAt, createdAt } = started.body.switch;
    expect(new Date(expiresAt).getTime() - new Date(createdAt).getTime()).toBe(hours * 3600 * 1000);

    // A downgrade writes no charge; a move from a free plan does.
    const down = await paidStore(pro);
    expect((await preview(down, { planId: basic.id })).body.preview).toMatchObject({ kind: 'scheduled', chargeExpiry: null });
    const fromFree = await paidStore(free, { daysLeft: 36500 });
    expect((await preview(fromFree, { planId: pro.id })).body.preview).toMatchObject({ kind: 'move', chargeExpiry: { hours } });
  });

  it('the same request again is the same charge; an amount other than the one shown is refused', async () => {
    const s = await paidStore();
    const first = await start(s, { planId: pro.id });
    const again = await start(s, { planId: pro.id });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, invoice: { id: first.body.invoice.id } });
    const wrong = await start(s, { planId: business.id, expectedAmount: 1 });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toMatchObject({ code: 'SWITCH_AMOUNT_CHANGED', details: { currency: 'EGP' } });
    expect(await pendingOf(s)).toHaveLength(1);
  });

  it('paid online: a webhook delivered twice switches once', async () => {
    const restoreConfig = fakeFawaterak.configure();
    const fake = fakeFawaterak.install();
    try {
      const s = await paidStore();
      const started = await start(s, { planId: pro.id });
      const pay = await request(app).post(url(s, '/payments')).set(s.H).send({});
      expect(pay.status).toBe(201);
      expect(pay.body.payment).toMatchObject({ amount: PRO, currency: 'EGP' });

      const intentKey = fake.latestIntentKey();
      const hook = (route, body) => request(app).post(`/api/v1/billing/fawaterak/${fakeFawaterak.FAKE_CONFIG.webhookToken}/${route}`).send(body);
      fake.pay(intentKey);
      expect((await hook('paid_json', fake.paidWebhook(intentKey))).status).toBe(200);
      expect((await hook('paid_json', fake.paidWebhook(intentKey))).status).toBe(200);
      const invoice = await db.BillingInvoice.findByPk(started.body.invoice.id);
      expect(invoice).toMatchObject({ status: 'paid', paymentSource: 'gateway' });
      expect((await subscriptionOf(s)).planId).toBe(pro.id);
      expect(await db.AuditLog.count({ where: { workspaceId: s.wid, action: 'subscription.plan_switch_applied' } })).toBe(1);
    } finally {
      fake.restore();
      restoreConfig();
    }
  });

  it('a renewal charge nobody is paying gives way to it', async () => {
    const s = await paidStore();
    const { invoice: renewal } = await charges.createCharge(s.wid);
    const started = await start(s, { planId: pro.id });
    expect(started.status).toBe(201);
    expect(await db.BillingInvoice.findByPk(renewal.id)).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect(await pendingOf(s)).toHaveLength(1);
  });

  it('two at once: one switch and one charge in the end', async () => {
    const s = await paidStore();
    const results = await Promise.all([start(s, { planId: pro.id }), start(s, { planId: business.id })]);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
    expect(await pendingOf(s)).toHaveLength(1);
    expect(await openOf(s)).toHaveLength(1);
  });
});

describe('a downgrade', () => {
  it('waits for the end of the paid period; the renewal is priced on it; the job applies it then', async () => {
    const s = await paidStore(pro);
    const started = await start(s, { planId: basic.id });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ kind: 'scheduled', invoice: null, switch: { status: 'scheduled' } });
    expect(new Date(started.body.switch.effectiveAt).getTime()).toBe(s.end.getTime());
    expect((await subscriptionOf(s)).planId).toBe(pro.id);
    expect(await db.BillingInvoice.count({ where: { workspaceId: s.wid, status: 'pending' } })).toBe(0);

    const renewal = await request(app).post(url(s, '/invoices/open')).set(s.H).send({});
    expect(renewal.body.invoice).toMatchObject({ id: 'next', amountDue: BASIC });

    expect(await switches.runDue()).toMatchObject({ applied: 0 });
    await db.PlanSwitch.update({ effectiveAt: new Date(Date.now() - 60000) }, { where: { workspaceId: s.wid } });
    expect(await switches.runDue()).toMatchObject({ applied: 1 });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
  });

  it('then an upgrade replaces it; an upgrade waiting is replaced by a downgrade', async () => {
    const s = await paidStore(pro);
    await start(s, { planId: basic.id });
    const up = await start(s, { planId: business.id });
    expect(up.status).toBe(201);
    expect(await db.PlanSwitch.count({ where: { workspaceId: s.wid, status: 'replaced', kind: 'scheduled' } })).toBe(1);
    const down = await start(s, { planId: free.id });
    expect(down.status).toBe(201);
    expect(await db.BillingInvoice.findByPk(up.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect(await openOf(s)).toHaveLength(1);
  });

  it('once the renewal is paid early at its price, it can no longer be cancelled, and still applies', async () => {
    const s = await paidStore(pro);
    await start(s, { planId: basic.id });
    const sent = await proof(s, 'next');
    expect(sent.status).toBe(201);
    expect(sent.body.proof).toMatchObject({ amount: BASIC });
    expect((await approve(sent.body.proof.id, BASIC)).status).toBe(200);
    // Paid ahead: the period runs on, still on Pro until the change.
    expect((await subscriptionOf(s)).planId).toBe(pro.id);

    const refused = await cancel(s);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PLAN_SWITCH_ALREADY_BILLED');
    expect((await start(s, { planId: business.id })).body.error.code).toBe('PLAN_SWITCH_ALREADY_BILLED');

    await db.PlanSwitch.update({ effectiveAt: new Date(Date.now() - 60000) }, { where: { workspaceId: s.wid } });
    expect(await switches.runDue()).toMatchObject({ applied: 1 });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
  });

  it('the billing cycle cannot be changed beside it', async () => {
    const s = await paidStore(pro);
    await start(s, { planId: basic.id });
    const res = await request(app).patch(url(s, '')).set(s.H).send({ billingCycle: 'yearly' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_SWITCH_WAITING');
  });
});

describe('not paid, or cancelled', () => {
  it('cancelling voids the charge: nothing owed, the store as it was', async () => {
    const s = await paidStore();
    const before = await subscriptionOf(s);
    const started = await start(s, { planId: pro.id });
    const res = await cancel(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cancelled: true, switch: { status: 'cancelled' }, plans: { planSwitch: { open: null } } });
    expect(await db.BillingInvoice.findByPk(started.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'cancelled' });
    expect((await subscriptionOf(s)).toJSON()).toEqual(before.toJSON());
    expect((await accessFor(s.wid)).reasons).toEqual([]);
    // And any plan again at once.
    expect((await start(s, { planId: business.id })).status).toBe(201);
  });

  it('the switch waiting says when a transfer for its charge is under review, until the console decides', async () => {
    const s = await paidStore();
    const started = await start(s, { planId: pro.id });
    expect(started.body.switch.proofUnderReview).toBe(false);
    expect((await plansOf(s)).body.planSwitch.open).toMatchObject({ status: 'pending', proofUnderReview: false });

    const sent = await proof(s, started.body.invoice.id);
    expect(sent.status).toBe(201);
    const open = (await plansOf(s)).body.planSwitch.open;
    expect(open).toMatchObject({ id: started.body.switch.id, proofUnderReview: true });
    // Every field it had is still there.
    for (const field of ['kind', 'status', 'from', 'to', 'effectiveAt', 'invoiceId', 'amountDue', 'currency', 'expiresAt', 'proration', 'createdAt']) {
      expect(open).toHaveProperty(field);
    }
    expect((await cancel(s)).body.error.code).toBe('PROOF_UNDER_REVIEW');

    // Rejected: the payment did not go through, so the charge is voided and the switch cancelled.
    const rejected = await request(app).post(`/api/v1/admin/payment-proofs/${sent.body.proof.id}/reject`).set(admin.H).send({ note: 'No transfer arrived' });
    expect(rejected.status).toBe(200);
    expect((await plansOf(s)).body.planSwitch.open).toBeNull();
    expect(await db.BillingInvoice.findByPk(started.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'payment_failed' });
    expect(await db.PlanSwitch.findByPk(started.body.switch.id)).toMatchObject({ status: 'cancelled', endReason: 'payment_failed' });
    expect((await cancel(s)).body).toMatchObject({ cancelled: false });

    // A scheduled switch has no charge to pay: never under review.
    const down = await paidStore(pro);
    await start(down, { planId: basic.id });
    expect((await plansOf(down)).body.planSwitch.open).toMatchObject({ status: 'scheduled', proofUnderReview: false });
  });

  it('left unpaid, the job voids it, unless a transfer for it is with the console', async () => {
    const a = await paidStore();
    const b = await paidStore();
    const left = await start(a, { planId: pro.id });
    const sentFor = await start(b, { planId: pro.id });
    await proof(b, sentFor.body.invoice.id);
    const old = new Date(Date.now() - (env.billing.planSwitch.chargeExpiryHours + 1) * 3600 * 1000);
    await db.sequelize.query('UPDATE plan_switches SET created_at = $old', { bind: { old } });
    await db.sequelize.query('UPDATE billing_invoices SET created_at = $old WHERE status = $pending', { bind: { old, pending: 'pending' } });
    const job = require('../../src/modules/billing/jobs').schedules.find((j) => j.name === 'billing.plan_switches');
    expect(await job.handle()).toMatchObject({ expired: 1 });
    expect(await db.BillingInvoice.findByPk(left.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'expired' });
    expect(await db.BillingInvoice.findByPk(sentFor.body.invoice.id)).toMatchObject({ status: 'pending' });
    expect((await cancel(b)).status).toBe(409);
  });

  it('a transfer approved after the console changed the plan is credited, never lost', async () => {
    const s = await paidStore();
    const started = await start(s, { planId: pro.id });
    const sent = await proof(s, started.body.invoice.id);
    const proofId = sent.body.proof.id;
    const changed = await request(app)
      .post(`/api/v1/admin/workspaces/${s.wid}/subscription/change-plan`)
      .set(admin.H)
      .send({ planId: business.id, note: 'Moved by support' });
    expect(changed.status).toBe(201);
    expect(await db.BillingInvoice.findByPk(started.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect(await db.PlanSwitch.findOne({ where: { workspaceId: s.wid } })).toMatchObject({ status: 'dropped', endReason: 'admin_change_plan' });

    expect((await approve(proofId, PRO)).status).toBe(200);
    expect((await subscriptionOf(s)).planId).toBe(business.id);
    const credit = await db.WalletLedgerEntry.findAll({ where: { workspaceId: s.wid, entryType: 'move_payment_credit' } });
    expect(credit).toHaveLength(1);
    expect(Number(credit[0].cashDelta)).toBe(PRO);
  });
});

describe('an ended or restricted period, manual and special cases', () => {
  it('an ended period changes plan at once, nothing to pay; the renewal is the new price', async () => {
    const s = await paidStore(basic, { daysLeft: -5 });
    const res = await start(s, { planId: pro.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'immediate', changed: true, invoice: null, switch: { status: 'applied' } });
    expect((await subscriptionOf(s)).planId).toBe(pro.id);
    const renewal = await request(app).post(url(s, '/invoices/open')).set(s.H).send({});
    expect(renewal.body.invoice).toMatchObject({ amountDue: PRO });
  });

  it('a restricted store moving to a free plan is active again', async () => {
    const s = await paidStore(basic, { daysLeft: -5, status: 'past_due' });
    await start(s, { planId: free.id });
    expect(await subscriptionOf(s)).toMatchObject({ planId: free.id, status: 'active' });
    expect((await accessFor(s.wid)).reasons).toEqual([]);
  });

  it('from a free plan: a full period of the new plan from its payment', async () => {
    const s = await paidStore(free, { daysLeft: 36500 });
    const res = await start(s, { planId: pro.id });
    expect(res.body).toMatchObject({ kind: 'move', created: true, invoice: { amountDue: PRO } });
    expect((await recordPayment(res.body.invoice.id, PRO)).status).toBe(200);
    const after = await subscriptionOf(s);
    expect(after.planId).toBe(pro.id);
    expect(after.currentPeriodEnd.getTime() - after.currentPeriodStart.getTime()).toBeLessThanOrEqual(31 * DAY);
  });

  it('dollars: an upgrade has no way to be paid; a downgrade or another currency waits for the period end', async () => {
    const s = await paidStore(usdPro);
    const up = await paidStore(usdBasic);
    const refused = await start(up, { planId: usdPro.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'NO_PAYMENT_METHOD', details: { currency: 'USD' } });
    expect((await start(s, { planId: usdBasic.id })).body).toMatchObject({ kind: 'scheduled' });
    expect((await start(up, { planId: pro.id })).body).toMatchObject({ kind: 'scheduled', switch: { to: { planId: pro.id } } });
  });

  it('a price set by the console, or special terms, go through support', async () => {
    const s = await paidStore();
    await db.Subscription.update({ pricingKind: 'free' }, { where: { workspaceId: s.wid } });
    const manual = await start(s, { planId: pro.id });
    expect(manual.status).toBe(409);
    expect(manual.body.error.code).toBe('MANUAL_PRICING');
    expect((await plansOf(s)).body.planSwitch).toMatchObject({ mode: 'support', reason: 'MANUAL_PRICING' });

    const t = await paidStore();
    const sub = await subscriptionOf(t);
    await db.SubscriptionTerm.create({ subscriptionId: sub.id, workspaceId: t.wid, kind: 'price_override', priceAmount: 10000, currency: 'EGP', chargesTotal: 3, chargesUsed: 0, note: 'Partner price' });
    const terms = await preview(t, { planId: pro.id });
    expect(terms.status).toBe(409);
    expect(terms.body.error.code).toBe('SPECIAL_TERMS_ACTIVE');
  });

  it('a payment by hand reversed puts the store back and the switch waits again', async () => {
    const s = await paidStore();
    const started = await start(s, { planId: pro.id });
    expect((await recordPayment(started.body.invoice.id, PRO)).status).toBe(200);
    expect((await subscriptionOf(s)).planId).toBe(pro.id);
    const reversed = await request(app).post(`/api/v1/admin/charges/${started.body.invoice.id}/reverse-payment`).set(admin.H).send({ reason: 'bounced' });
    expect(reversed.status).toBe(200);
    const back = await subscriptionOf(s);
    expect(back.planId).toBe(basic.id);
    expect(back.currentPeriodEnd.getTime()).toBe(s.end.getTime());
    expect(await db.PlanSwitch.findOne({ where: { workspaceId: s.wid } })).toMatchObject({ status: 'pending' });
  });
});

describe('the next renewal in the preview', () => {
  it('has a date for every kind but one whose period starts on payment, and is left out for a free plan', async () => {
    const s = await paidStore();
    const at = (body) => body.preview.nextRenewal && body.preview.nextRenewal.at;
    // An upgrade now: its period starts when it is paid. At the period's end: then.
    expect(at((await preview(s, { planId: pro.id })).body)).toBeNull();
    expect(new Date(at((await preview(s, { planId: pro.id, timing: 'period_end' })).body)).getTime()).toBe(s.end.getTime());
    const same = (await preview(s, { planId: basic.id })).body;
    expect(same.preview.kind).toBe('none');
    expect(new Date(at(same)).getTime()).toBe(s.end.getTime());
    const down = (await preview(s, { planId: free.id })).body;
    expect(down.preview).toMatchObject({ kind: 'scheduled', nextRenewal: null });

    // A move's period starts when it is paid: from a free plan, and from pay per order.
    const fromFree = await paidStore(free, { daysLeft: 36500 });
    expect((await preview(fromFree, { planId: pro.id })).body.preview).toMatchObject({ kind: 'move', nextRenewal: { at: null, amount: PRO, billingCycle: 'monthly' } });
    const fee = await db.Plan.create({ key: 'ppo', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, currency: 'EGP', isPublic: true, isActive: true, perOrderFeeAmount: 400 });
    const ppo = await paidStore(fee, { daysLeft: 36500 });
    expect((await preview(ppo, { planId: pro.id })).body.preview).toMatchObject({ kind: 'move', reason: 'pay_per_order', nextRenewal: { at: null } });
  });
});

describe('the paths that stay as they were', () => {
  it('a trial changes plan at once; pay per order moves with no trial', async () => {
    const trial = await paidStore(basic, { status: 'trialing' });
    const res = await start(trial, { planId: pro.id });
    expect(res.body).toMatchObject({ kind: 'trial_change', switch: null });
    expect((await subscriptionOf(trial)).planId).toBe(pro.id);

    const fee = await db.Plan.create({ key: 'ppo', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, currency: 'EGP', isPublic: true, isActive: true, perOrderFeeAmount: 400 });
    const ppo = await paidStore(fee, { daysLeft: 36500 });
    const moved = await start(ppo, { planId: pro.id });
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ kind: 'move', created: true, switch: null, invoice: { targetPlanId: pro.id, amountDue: PRO } });
    expect(await db.PlanSwitch.count({ where: { workspaceId: ppo.wid } })).toBe(0);
  });
});

// ------------------------------------------------------------ phase two

const cancelCharge = (s, id) => request(app).post(url(s, `/charges/${id}/cancel`)).set(s.H).send({});
const voidCharge = (id, body) => request(app).post(`/api/v1/admin/charges/${id}/void`).set(admin.H).send(body);
const invoicesOf = (s) => request(app).get(url(s, '/invoices')).set(s.H);
const consoleChargesOf = (s) => request(app).get(`/api/v1/admin/workspaces/${s.wid}/charges`).set(admin.H);
const toPast = (s) => db.PlanSwitch.update({ effectiveAt: new Date(Date.now() - 60000) }, { where: { workspaceId: s.wid, status: 'scheduled' } });
const pendingCharge = async (s, extra = {}) => {
  const sub = await subscriptionOf(s);
  return db.BillingInvoice.create({
    workspaceId: s.wid, subscriptionId: sub.id, grossAmount: BASIC, amount: BASIC, currency: 'EGP', status: 'pending',
    periodStart: sub.currentPeriodEnd, periodEnd: new Date(sub.currentPeriodEnd.getTime() + 30 * DAY), ...extra,
  });
};

describe('an upgrade at the end of the period', () => {
  it('waits with nothing to pay; the renewal is the new price; the job applies it then and writes that renewal', async () => {
    const s = await paidStore();
    const started = await start(s, { planId: pro.id, timing: 'period_end', expectedAmount: 0 });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ kind: 'scheduled', created: true, invoice: null, switch: { kind: 'scheduled', status: 'scheduled', reason: 'upgrade', timing: 'period_end' } });
    expect(new Date(started.body.switch.effectiveAt).getTime()).toBe(s.end.getTime());
    expect((await plansOf(s)).body.planSwitch.open).toMatchObject({ status: 'scheduled', reason: 'upgrade', to: { planId: pro.id } });
    expect(await pendingOf(s)).toHaveLength(0);
    expect((await subscriptionOf(s)).planId).toBe(basic.id);

    // Paying the next period early: already at the new price.
    const next = await request(app).post(url(s, '/invoices/open')).set(s.H).send({});
    expect(next.body.invoice).toMatchObject({ id: 'next', amountDue: PRO });

    expect(await switches.runDue()).toMatchObject({ applied: 0 });
    await toPast(s);
    expect(await switches.runDue()).toMatchObject({ applied: 1 });
    const after = await subscriptionOf(s);
    expect(after.planId).toBe(pro.id);
    expect(after.currentPeriodEnd.getTime()).toBe(s.end.getTime());
    const [renewal] = await pendingOf(s);
    expect(renewal).toMatchObject({ targetPlanId: null, currency: 'EGP' });
    expect(Number(renewal.amount)).toBe(PRO);
    expect(renewal.periodStart.getTime()).toBe(s.end.getTime());
    // It shows as a pending invoice the merchant may cancel.
    const listed = (await invoicesOf(s)).body.invoices.find((i) => i.id === renewal.id);
    expect(listed).toMatchObject({ status: 'pending', amountDue: PRO, cancellable: true });
  });

  it('is cancelled before then with the same cancel, and the store stays as it is', async () => {
    const s = await paidStore();
    await start(s, { planId: pro.id, timing: 'period_end' });
    const res = await cancel(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cancelled: true, switch: { status: 'cancelled', reason: 'upgrade', timing: 'period_end' } });
    await db.PlanSwitch.update({ effectiveAt: new Date(Date.now() - 60000) }, { where: { workspaceId: s.wid } });
    expect(await switches.runDue()).toMatchObject({ applied: 0 });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
    expect(await db.BillingInvoice.count({ where: { workspaceId: s.wid, status: 'pending' } })).toBe(0);
  });

  it('choosing "now" afterwards replaces it with a charge at the full price', async () => {
    const s = await paidStore();
    await start(s, { planId: pro.id, timing: 'period_end' });
    const now = await start(s, { planId: pro.id, timing: 'now' });
    expect(now.status).toBe(201);
    expect(now.body).toMatchObject({ kind: 'upgrade', invoice: { amountDue: PRO } });
    expect(await db.PlanSwitch.count({ where: { workspaceId: s.wid, status: 'replaced' } })).toBe(1);
    expect(await openOf(s)).toHaveLength(1);
  });

  it('paid ahead at the new price: no second renewal when it applies', async () => {
    const s = await paidStore();
    await start(s, { planId: pro.id, timing: 'period_end' });
    const sent = await proof(s, 'next');
    expect(sent.status).toBe(201);
    expect(sent.body.proof).toMatchObject({ amount: PRO });
    expect((await approve(sent.body.proof.id, PRO)).status).toBe(200);
    expect((await cancel(s)).body.error.code).toBe('PLAN_SWITCH_ALREADY_BILLED');
    await toPast(s);
    expect(await switches.runDue()).toMatchObject({ applied: 1 });
    expect((await subscriptionOf(s)).planId).toBe(pro.id);
    expect(await pendingOf(s)).toHaveLength(0);
  });

  it('a timing the switch does not offer is 409; one that does not exist is 422', async () => {
    const s = await paidStore(pro);
    const down = await start(s, { planId: basic.id, timing: 'now' });
    expect(down.status).toBe(409);
    expect(down.body.error).toMatchObject({ code: 'SWITCH_TIMING_NOT_AVAILABLE', details: { timing: 'now', available: ['period_end'] } });
    expect((await preview(s, { planId: basic.id, timing: 'now' })).status).toBe(409);
    expect((await preview(s, { planId: basic.id, timing: 'period_end' })).body.preview).toMatchObject({ kind: 'scheduled', timing: 'period_end' });
    const unknown = await start(s, { planId: business.id, timing: 'tomorrow' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('VALIDATION_ERROR');
    expect(await openOf(s)).toHaveLength(0);
  });
});

describe('a move to pay per order', () => {
  let fee;

  beforeEach(async () => {
    env.wallet.enabled = true;
    fee = await db.Plan.create({ key: 'ppo', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, currency: 'EGP', isPublic: true, isActive: true, perOrderFeeAmount: 400 });
  });

  afterEach(() => {
    env.wallet.enabled = false;
  });

  it('its card opens the switch; like a downgrade: nothing charged, applied by the job at the end of the paid period', async () => {
    const s = await paidStore();
    expect((await plansOf(s)).body).toMatchObject({ payPerOrder: { available: true, current: false, plan: { id: fee.id } }, planSwitch: { enabled: true, mode: 'switch' } });

    const shown = await preview(s, { planId: fee.id });
    expect(shown.status).toBe(200);
    expect(shown.body.preview).toMatchObject({
      kind: 'scheduled',
      reason: 'to_pay_per_order',
      timings: ['period_end'],
      effective: 'period_end',
      amountDue: 0,
      payable: false,
      chargeExpiry: null,
      nextRenewal: null,
      to: { planId: fee.id, billingCycle: 'monthly' },
    });
    expect(new Date(shown.body.preview.effectiveAt).getTime()).toBe(s.end.getTime());

    const started = await start(s, { planId: fee.id, expectedAmount: 0 });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ kind: 'scheduled', invoice: null, switch: { status: 'scheduled', reason: 'to_pay_per_order', to: { planId: fee.id } } });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
    expect(await pendingOf(s)).toHaveLength(0);
    // No renewal can be paid for the period that will be pay per order.
    const renewal = await request(app).post(url(s, '/invoices/open')).set(s.H).send({});
    expect(renewal.status).toBe(409);
    expect(renewal.body.error.code).toBe('PLAN_IS_FREE');

    await toPast(s);
    expect(await switches.runDue()).toMatchObject({ applied: 1 });
    const after = await subscriptionOf(s);
    expect(after).toMatchObject({ planId: fee.id, status: 'active', trialEndsAt: null });
    expect(after.currentPeriodEnd.getUTCFullYear()).toBeGreaterThan(new Date().getUTCFullYear() + 50);
    expect(await db.BillingInvoice.count({ where: { workspaceId: s.wid, status: 'pending' } })).toBe(0);
    expect((await plansOf(s)).body.payPerOrder).toMatchObject({ current: true });
  });

  it('cancelled before it applies, nothing changes', async () => {
    const s = await paidStore();
    await start(s, { planId: fee.id });
    expect((await cancel(s)).body).toMatchObject({ cancelled: true, switch: { status: 'cancelled', reason: 'to_pay_per_order' } });
    await db.PlanSwitch.update({ effectiveAt: new Date(Date.now() - 60000) }, { where: { workspaceId: s.wid } });
    expect(await switches.runDue()).toMatchObject({ applied: 0 });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
  });

  it('dropped at its moment if the prepaid balance was turned off; a trial chooses it on its own card', async () => {
    const s = await paidStore();
    await start(s, { planId: fee.id });
    env.wallet.enabled = false;
    await toPast(s);
    expect(await switches.runDue()).toMatchObject({ applied: 0, dropped: 1 });
    expect(await db.PlanSwitch.findOne({ where: { workspaceId: s.wid } })).toMatchObject({ status: 'dropped', endReason: 'wallet_disabled' });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
    // Off: not on offer through the switch.
    expect((await preview(s, { planId: fee.id })).status).toBe(422);

    env.wallet.enabled = true;
    const trial = await paidStore(basic, { status: 'trialing' });
    const refused = await start(trial, { planId: fee.id });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PLAN_NOT_AVAILABLE');
  });

  it('once the period has ended: at once', async () => {
    const s = await paidStore(basic, { daysLeft: -3, status: 'past_due' });
    const res = await start(s, { planId: fee.id });
    expect(res.body).toMatchObject({ kind: 'immediate', changed: true, switch: { status: 'applied', reason: 'to_pay_per_order' } });
    expect(await subscriptionOf(s)).toMatchObject({ planId: fee.id, status: 'active' });
  });
});

describe('the merchant cancelling a pending charge', () => {
  it('a renewal: void, the store as it was; the list says which may be cancelled', async () => {
    const s = await paidStore();
    const before = await subscriptionOf(s);
    const { invoice: renewal } = await charges.createCharge(s.wid);
    const listed = (await invoicesOf(s)).body.invoices;
    expect(listed.find((i) => i.id === renewal.id)).toMatchObject({ status: 'pending', cancellable: true });
    expect(listed.find((i) => i.status === 'paid')).toMatchObject({ cancellable: false });

    const res = await cancelCharge(s, renewal.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ invoice: { id: renewal.id, status: 'void', voidReason: 'cancelled_by_merchant', cancellable: false } });
    expect(await db.BillingInvoice.findByPk(renewal.id)).toMatchObject({ status: 'void', voidReason: 'cancelled_by_merchant' });
    expect((await subscriptionOf(s)).toJSON()).toEqual(before.toJSON());
    expect(await db.AuditLog.count({ where: { entityId: renewal.id, action: 'billing_invoice.void' } })).toBe(1);

    const again = await cancelCharge(s, renewal.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CHARGE_NOT_PENDING');
  });

  it("an upgrade's charge: its switch is cancelled with it", async () => {
    const s = await paidStore();
    const started = await start(s, { planId: pro.id });
    const res = await cancelCharge(s, started.body.invoice.id);
    expect(res.status).toBe(200);
    expect(res.body.plans.planSwitch.open).toBeNull();
    expect(await db.PlanSwitch.findByPk(started.body.switch.id)).toMatchObject({ status: 'cancelled', endReason: 'charge_cancelled' });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
  });

  it('refused while a transfer for it is being checked; a paid one is never touched', async () => {
    const s = await paidStore();
    const started = await start(s, { planId: pro.id });
    const sent = await proof(s, started.body.invoice.id);
    expect(sent.status).toBe(201);
    expect((await invoicesOf(s)).body.invoices.find((i) => i.id === started.body.invoice.id)).toMatchObject({ cancellable: false });
    const refused = await cancelCharge(s, started.body.invoice.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'PROOF_UNDER_REVIEW', details: { invoiceId: started.body.invoice.id } });
    expect((await db.BillingInvoice.findByPk(started.body.invoice.id)).status).toBe('pending');

    const paid = await db.BillingInvoice.findOne({ where: { workspaceId: s.wid, status: 'paid' } });
    const paidRes = await cancelCharge(s, paid.id);
    expect(paidRes.status).toBe(409);
    expect(paidRes.body.error.code).toBe('CHARGE_ALREADY_PAID');
    expect((await db.BillingInvoice.findByPk(paid.id)).status).toBe('paid');
  });

  it("another store's charge is not found; with the flag off it is 404 and nothing is cancellable", async () => {
    const s = await paidStore();
    const other = await paidStore();
    const { invoice } = await charges.createCharge(s.wid);
    expect((await cancelCharge(other, invoice.id)).status).toBe(404);
    env.billing.planSwitch.enabled = false;
    const off = await cancelCharge(s, invoice.id);
    expect(off.status).toBe(404);
    expect(off.body.error.code).toBe('PLAN_SWITCH_DISABLED');
    expect((await invoicesOf(s)).body.invoices.every((i) => i.cancellable === false)).toBe(true);
    expect((await db.BillingInvoice.findByPk(invoice.id)).status).toBe('pending');
  });
});

describe('the console voiding a pending charge', () => {
  it('voids it with its reason, audited; a switch waiting for it is dropped; the charges list says so', async () => {
    const s = await paidStore();
    const started = await start(s, { planId: pro.id });
    const listedBefore = (await consoleChargesOf(s)).body.charges.find((c) => c.id === started.body.invoice.id);
    expect(listedBefore).toMatchObject({ status: 'pending', voidable: true, voidNote: null });

    const res = await voidCharge(started.body.invoice.id, { reason: 'Asked by phone to drop it' });
    expect(res.status).toBe(200);
    expect(res.body.charge).toMatchObject({ status: 'void', voidReason: 'voided_by_admin', voidNote: 'Asked by phone to drop it', voidable: false });
    expect(await db.PlanSwitch.findByPk(started.body.switch.id)).toMatchObject({ status: 'dropped', endReason: 'admin_void' });
    const audit = await db.AuditLog.findOne({ where: { entityId: started.body.invoice.id, action: 'billing_invoice.void' } });
    expect(audit).toBeTruthy();
    expect(audit.actorUserId).toBe(admin.userId);
    expect((await consoleChargesOf(s)).body.charges.find((c) => c.id === started.body.invoice.id)).toMatchObject({ voidReason: 'voided_by_admin', voidNote: 'Asked by phone to drop it', voidable: false });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
  });

  it('a reason is required; a charge with a transfer waiting, or a paid one, is refused', async () => {
    const s = await paidStore();
    const { invoice } = await charges.createCharge(s.wid);
    const noReason = await voidCharge(invoice.id, {});
    expect(noReason.status).toBe(422);
    const sent = await proof(s, invoice.id);
    expect(sent.status).toBe(201);
    expect((await consoleChargesOf(s)).body.charges.find((c) => c.id === invoice.id)).toMatchObject({ voidable: false });
    const waiting = await voidCharge(invoice.id, { reason: 'Duplicate' });
    expect(waiting.status).toBe(409);
    expect(waiting.body.error.code).toBe('PROOF_UNDER_REVIEW');
    const paid = await db.BillingInvoice.findOne({ where: { workspaceId: s.wid, status: 'paid' } });
    expect((await voidCharge(paid.id, { reason: 'x' })).body.error.code).toBe('CHARGE_ALREADY_PAID');
    env.billing.planSwitch.enabled = false;
    expect((await voidCharge(invoice.id, { reason: 'x' })).status).toBe(404);
  });
});

describe('a payment that did not go through', () => {
  it("online: the failed webhook voids the upgrade's charge and cancels the switch; a renewal's stays payable", async () => {
    const restoreConfig = fakeFawaterak.configure();
    const fake = fakeFawaterak.install();
    try {
      const hook = (route, body) => request(app).post(`/api/v1/billing/fawaterak/${fakeFawaterak.FAKE_CONFIG.webhookToken}/${route}`).send(body);
      const s = await paidStore();
      const started = await start(s, { planId: pro.id });
      expect((await request(app).post(url(s, '/payments')).set(s.H).send({})).status).toBe(201);
      await hook('failed_json', fake.failedWebhook(fake.latestIntentKey()));
      expect(await db.BillingInvoice.findByPk(started.body.invoice.id)).toMatchObject({ status: 'void', voidReason: 'payment_failed' });
      expect(await db.PlanSwitch.findByPk(started.body.switch.id)).toMatchObject({ status: 'cancelled', endReason: 'payment_failed' });
      expect(await subscriptionOf(s)).toMatchObject({ planId: basic.id, status: 'active' });
      expect(await pendingOf(s)).toHaveLength(0);
      expect((await plansOf(s)).body.planSwitch.open).toBeNull();

      const r = await paidStore();
      const { invoice: renewal } = await charges.createCharge(r.wid);
      expect((await request(app).post(url(r, '/payments')).set(r.H).send({})).status).toBe(201);
      await hook('failed_json', fake.failedWebhook(fake.latestIntentKey()));
      expect((await db.BillingInvoice.findByPk(renewal.id)).status).toBe('pending');
    } finally {
      fake.restore();
      restoreConfig();
    }
  });
});

describe('a plan change replaces any pending charge', () => {
  it("a trial's change through the switch replaces it; not while a transfer for it is being checked; /plan as before", async () => {
    const trial = await paidStore(basic, { status: 'trialing' });
    const waiting = await pendingCharge(trial);
    const old = await request(app).post(url(trial, '/plan')).set(trial.H).send({ planId: pro.id });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('OPEN_CHARGE_EXISTS');

    const res = await start(trial, { planId: pro.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'trial_change', changed: true });
    expect(await db.BillingInvoice.findByPk(waiting.id)).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect((await subscriptionOf(trial)).planId).toBe(pro.id);

    const checked = await paidStore(basic, { status: 'trialing' });
    const charge = await pendingCharge(checked);
    expect((await proof(checked, charge.id)).status).toBe(201);
    const refused = await start(checked, { planId: pro.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'PROOF_UNDER_REVIEW', details: { invoiceId: charge.id } });
    expect((await subscriptionOf(checked)).planId).toBe(basic.id);
  });

  it("pay per order: the move replaces a renewal still pending", async () => {
    const fee = await db.Plan.create({ key: 'ppo', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, currency: 'EGP', isPublic: true, isActive: true, perOrderFeeAmount: 400 });
    const ppo = await paidStore(fee, { daysLeft: 36500 });
    const waiting = await pendingCharge(ppo);
    const old = await request(app).post(url(ppo, '/plan-move')).set(ppo.H).send({ planId: pro.id });
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('OPEN_CHARGE_EXISTS');
    const moved = await start(ppo, { planId: pro.id });
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ kind: 'move', invoice: { targetPlanId: pro.id, amountDue: PRO } });
    expect(await db.BillingInvoice.findByPk(waiting.id)).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect(await pendingOf(ppo)).toHaveLength(1);
  });
});
