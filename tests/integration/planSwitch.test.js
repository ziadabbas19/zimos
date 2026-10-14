'use strict';

// A merchant changing plan by themselves (billing/planSwitchService,
// PLAN_SWITCH_ENABLED, migration 702):
//
//   POST /workspaces/:id/billing/plan-switch/preview | /plan-switch | /plan-switch/cancel
//   billing job: billing.plan_switches (planSwitchService.runDue)
//
// An upgrade pays the difference for the days left and starts once paid; a
// downgrade waits for the end of the paid period; an ended period changes at
// once. Paid by a transfer's proof, online (Fawaterak, faked) or by the
// console; voided when cancelled, replaced or left unpaid.

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
  it('previews the difference, starts one charge, and switches once a transfer is approved', async () => {
    const s = await paidStore();
    const shown = await preview(s, { planId: pro.id });
    expect(shown.status).toBe(200);
    expect(shown.body.preview).toMatchObject({
      kind: 'upgrade',
      effective: 'on_payment',
      amountDue: 20000,
      currency: 'EGP',
      proration: { remainingDays: 20, cycleDays: 30, fromPrice: BASIC, toPrice: PRO },
      nextRenewal: { amount: PRO, billingCycle: 'monthly' },
      payable: true,
      blockedBy: null,
    });
    expect(await db.BillingInvoice.count({ where: { workspaceId: s.wid, status: 'pending' } })).toBe(0);

    const started = await start(s, { planId: pro.id, expectedAmount: 20000 });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ kind: 'upgrade', created: true, invoice: { status: 'pending', amountDue: 20000, targetPlanId: pro.id } });
    expect(started.body.plans.planSwitch).toMatchObject({ enabled: true, mode: 'switch', open: { kind: 'upgrade', status: 'pending', amountDue: 20000 } });
    expect((await subscriptionOf(s)).planId).toBe(basic.id);

    // The usual Pay dialog finds it.
    const opened = await request(app).post(url(s, '/invoices/open')).set(s.H).send({});
    expect(opened.body).toMatchObject({ written: true, invoice: { id: started.body.invoice.id, amountDue: 20000 } });

    const sent = await proof(s, started.body.invoice.id);
    expect(sent.status).toBe(201);
    expect((await approve(sent.body.proof.id, 20000)).status).toBe(200);

    const after = await subscriptionOf(s);
    expect(after).toMatchObject({ planId: pro.id, status: 'active', billingCycle: 'monthly' });
    expect(after.currentPeriodEnd.getTime()).toBe(s.end.getTime());
    expect(await db.PlanSwitch.findOne({ where: { workspaceId: s.wid } })).toMatchObject({ status: 'applied' });
    // The next renewal is the new plan's full price, from the end of the paid period.
    const next = await request(app).post(url(s, '/invoices/open')).set(s.H).send({});
    expect(next.body.invoice).toMatchObject({ id: 'next', amountDue: PRO });
    expect(new Date(next.body.invoice.periodStart).getTime()).toBe(s.end.getTime());
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

  it('paid online: a webhook delivered twice switches once; a failed payment leaves the charge payable', async () => {
    const restoreConfig = fakeFawaterak.configure();
    const fake = fakeFawaterak.install();
    try {
      const s = await paidStore();
      const started = await start(s, { planId: pro.id });
      const pay = await request(app).post(url(s, '/payments')).set(s.H).send({});
      expect(pay.status).toBe(201);
      expect(pay.body.payment).toMatchObject({ amount: 20000, currency: 'EGP' });

      const intentKey = fake.latestIntentKey();
      const hook = (route, body) => request(app).post(`/api/v1/billing/fawaterak/${fakeFawaterak.FAKE_CONFIG.webhookToken}/${route}`).send(body);
      await hook('failed_json', fake.failedWebhook(intentKey));
      expect((await db.BillingInvoice.findByPk(started.body.invoice.id)).status).toBe('pending');
      expect((await subscriptionOf(s)).status).toBe('active');

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

    expect((await approve(proofId, 20000)).status).toBe(200);
    expect((await subscriptionOf(s)).planId).toBe(business.id);
    const credit = await db.WalletLedgerEntry.findAll({ where: { workspaceId: s.wid, entryType: 'move_payment_credit' } });
    expect(credit).toHaveLength(1);
    expect(Number(credit[0].cashDelta)).toBe(20000);
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
    expect((await recordPayment(started.body.invoice.id, 20000)).status).toBe(200);
    expect((await subscriptionOf(s)).planId).toBe(pro.id);
    const reversed = await request(app).post(`/api/v1/admin/charges/${started.body.invoice.id}/reverse-payment`).set(admin.H).send({ reason: 'bounced' });
    expect(reversed.status).toBe(200);
    expect((await subscriptionOf(s)).planId).toBe(basic.id);
    expect(await db.PlanSwitch.findOne({ where: { workspaceId: s.wid } })).toMatchObject({ status: 'pending' });
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
