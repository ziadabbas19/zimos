'use strict';

// What happens today when a store's free trial ends, and how a merchant pays
// from the first day. These tests pin the current behaviour; they change
// nothing:
//   - nothing runs billingService.expireStaleTrials on its own: only POST
//     /billing/run-trial-check, by hand, writes past_due;
//   - the lifecycle (workspaces/workspaceAccessService) counts a lapsed trial
//     as past_due on the fly, and restricts only under BILLING_RESTRICTIONS=enforce;
//   - POST /workspaces/:id/billing/plan reads the stored status, so a trial
//     that ended still changes plan at once, with no charge;
//   - a charge, its transfer proof and the console's approval make the
//     subscription active from the day it is paid, trial or draft alike.

const sharp = require('sharp');
const { app, request, registerAndActivate, createWorkspace, createProductWithVariant, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const { accessFor } = require('../../src/modules/workspaces/workspaceAccessService');
const { addMonths } = require('../../src/modules/billing/planPricing');

const DAY_MS = 24 * 60 * 60 * 1000;
const BASIC = 29900;
const PRO = 59900;
const ORIGINAL = { restrictions: env.billing.restrictions, requireSubscription: env.signup.requireSubscription };

let basic;
let pro;

beforeEach(async () => {
  [basic, pro] = await db.Plan.bulkCreate([
    { key: 'eg-basic', name: 'Basic', monthlyPriceAmount: BASIC, yearlyPriceAmount: BASIC * 10, currency: 'EGP', trialDays: 14, isPublic: true, displayOrder: 1 },
    { key: 'eg-pro', name: 'Pro', monthlyPriceAmount: PRO, yearlyPriceAmount: PRO * 10, currency: 'EGP', trialDays: 14, isPublic: true, displayOrder: 2 },
  ]);
  await db.PaymentMethod.bulkCreate([
    { kind: 'manual', code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10, enabled: true, accountNumber: 'zimos@instapay' },
  ]);
});

afterEach(() => {
  env.billing.restrictions = ORIGINAL.restrictions;
  env.signup.requireSubscription = ORIGINAL.requireSubscription;
});

async function newStore(name = 'Trial Store') {
  const owner = await registerAndActivate({ fullName: 'Hala Trial' });
  const H = { Authorization: `Bearer ${owner.accessToken}` };
  const workspace = await createWorkspace(owner.accessToken, name);
  return { owner, H, wid: workspace.id };
}

const subscriptionOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });

/** The trial (and its period) ended `days` ago, as if 14 days had passed and then some. */
async function lapseTrial(wid, days = 10) {
  const end = new Date(Date.now() - days * DAY_MS);
  await db.Subscription.update(
    { trialEndsAt: end, currentPeriodStart: new Date(end.getTime() - 14 * DAY_MS), currentPeriodEnd: end },
    { where: { workspaceId: wid } }
  );
  return end;
}

let shade = 0;
async function screenshot() {
  shade += 1;
  return sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 10, g: shade % 256, b: 200 } } })
    .png()
    .toBuffer();
}

/**
 * Opens the charge, sends its transfer proof, and has the console approve it.
 * Returns the charge the proof wrote, as stored once approved: open only
 * quotes it, and the dates are set when it is written.
 */
async function payByTransfer(store, admin) {
  // res.json (200): the pending charge, or the quote of the next one under the id `next`.
  const opened = await request(app).post(`/api/v1/workspaces/${store.wid}/billing/invoices/open`).set(store.H).send({});
  expect(opened.status).toBe(200);
  const quote = opened.body.invoice;
  const sent = await request(app)
    .post(`/api/v1/workspaces/${store.wid}/billing/invoices/${quote.id}/payment-proofs`)
    .set(store.H)
    .field('methodCode', 'instapay')
    .field('senderPhone', '01012345678')
    .attach('file', await screenshot(), { filename: 'transfer.png', contentType: 'image/png' });
  expect(sent.status).toBe(201);
  expect(sent.body.proof).toMatchObject({ status: 'pending', amount: quote.amountDue });
  const approved = await request(app)
    .post(`/api/v1/admin/payment-proofs/${sent.body.proof.id}/approve`)
    .set(admin.H)
    .send({ receivedAmount: quote.amountDue });
  expect(approved.status).toBe(200);
  return db.BillingInvoice.findByPk(sent.body.proof.invoiceId);
}

describe('a trial that ended 10 days ago', () => {
  it('still says trialing in the database; the lifecycle counts it past_due on the fly', async () => {
    const store = await newStore();
    const fresh = await subscriptionOf(store.wid);
    expect(fresh).toMatchObject({ status: 'trialing', planId: basic.id });
    expect(fresh.trialEndsAt.getTime()).toBe(fresh.currentPeriodEnd.getTime());

    const end = await lapseTrial(store.wid);
    expect((await subscriptionOf(store.wid)).status).toBe('trialing');

    env.billing.restrictions = 'warn';
    const warned = await accessFor(store.wid);
    expect(warned).toMatchObject({ restricted: false, reasons: [], billing: { phase: 'restricted', status: 'past_due', storedStatus: 'trialing', trialing: true, enforced: false } });
    env.billing.restrictions = 'enforce';
    expect(await accessFor(store.wid)).toMatchObject({ restricted: true, reasons: ['billing'], billing: { phase: 'restricted', enforced: true } });

    // What the dashboard reads. The Subscription summary: the stored status
    // and the trial's end date, now in the past.
    const { billing } = (await request(app).get(`/api/v1/workspaces/${store.wid}/billing`).set(store.H)).body;
    expect(billing.subscription.status).toBe('trialing');
    expect(new Date(billing.subscription.trialEndsAt).getTime()).toBe(end.getTime());
    // The Plans tab: the lifecycle status, yet the plan still changes at once.
    const plans = (await request(app).get(`/api/v1/workspaces/${store.wid}/billing/plans`).set(store.H)).body;
    expect(plans.subscription.status).toBe('past_due');
    expect(plans.planChange).toBe('immediate');
    // The banner.
    env.billing.restrictions = 'warn';
    const banner = (await request(app).get(`/api/v1/workspaces/${store.wid}/access`).set(store.H)).body.access;
    expect(banner).toMatchObject({ restricted: false, billing: { phase: 'restricted', status: 'past_due', trialing: true, enforced: false } });
  });

  it('restricts nothing under BILLING_RESTRICTIONS=warn; under enforce the storefront and new products stop', async () => {
    const store = await newStore();
    await lapseTrial(store.wid);
    const createProduct = () =>
      request(app).post(`/api/v1/workspaces/${store.wid}/catalog/products`).set(store.H).send({ name: 'New', status: 'active' });

    env.billing.restrictions = 'warn';
    expect((await request(app).get(`/api/v1/store/${store.wid}`)).status).toBe(200);
    expect((await createProduct()).status).toBe(201);

    env.billing.restrictions = 'enforce';
    const storefront = await request(app).get(`/api/v1/store/${store.wid}`);
    expect(storefront.status).toBe(423);
    expect(storefront.body.error.code).toBe('STORE_UNAVAILABLE');
    const blocked = await createProduct();
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('changes plan at once, with no charge and no payment asked, and the trial end stays where it was', async () => {
    const store = await newStore();
    const end = await lapseTrial(store.wid);

    const res = await request(app).post(`/api/v1/workspaces/${store.wid}/billing/plan`).set(store.H).send({ planId: pro.id, billingCycle: 'yearly' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);

    const sub = await subscriptionOf(store.wid);
    expect(sub).toMatchObject({ status: 'trialing', planId: pro.id, billingCycle: 'yearly' });
    expect(sub.currentPeriodEnd.getTime()).toBe(end.getTime());
    expect(sub.trialEndsAt.getTime()).toBe(end.getTime());
    expect(await db.BillingInvoice.count({ where: { workspaceId: store.wid } })).toBe(0);
    expect(await db.PaymentProof.count({ where: { workspaceId: store.wid } })).toBe(0);
    expect(await db.AuditLog.count({ where: { workspaceId: store.wid, action: 'subscription.plan_change' } })).toBe(1);
    // Still lapsed: changing plan extends nothing.
    expect((await accessFor(store.wid)).billing.phase).toBe('restricted');
  });

  it('is written past_due only by the hand-run trial check, which leaves a running trial alone; after it the plan change needs support', async () => {
    const lapsed = await newStore('Lapsed Store');
    const running = await newStore('Running Store');
    await lapseTrial(lapsed.wid);
    const admin = await makePlatformUser('admin');

    const check = await request(app).post('/api/v1/billing/run-trial-check').set(admin.H).send({});
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ expired: 1 });
    expect((await subscriptionOf(lapsed.wid)).status).toBe('past_due');
    expect((await subscriptionOf(running.wid)).status).toBe('trialing');

    const res = await request(app).post(`/api/v1/workspaces/${lapsed.wid}/billing/plan`).set(lapsed.H).send({ planId: pro.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PLAN_CHANGE_NEEDS_SUPPORT');
  });
});

describe('paying from the first day, by transfer', () => {
  it('a running trial: plan → charge → proof → approval → active from today; the unused trial days are not added', async () => {
    const store = await newStore();
    const admin = await makePlatformUser('admin');
    const trialEnd = (await subscriptionOf(store.wid)).trialEndsAt;

    const chosen = await request(app).post(`/api/v1/workspaces/${store.wid}/billing/plan`).set(store.H).send({ planId: pro.id, billingCycle: 'monthly' });
    expect(chosen.status).toBe(200);

    const before = Date.now();
    const invoice = await payByTransfer(store, admin);
    // Priced from the plan and cycle on the subscription (no code attached),
    // and dated from today, not from the trial's end. The row's BIGINT
    // amounts come back as strings.
    expect(invoice.currency).toBe('EGP');
    expect([invoice.grossAmount, invoice.discountAmount, invoice.amount].map(Number)).toEqual([PRO, 0, PRO]);
    const start = new Date(invoice.periodStart);
    expect(start.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(start.getTime()).toBeLessThan(trialEnd.getTime());

    const sub = await subscriptionOf(store.wid);
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodStart.getTime()).toBe(start.getTime());
    expect(sub.currentPeriodEnd.getTime()).toBe(new Date(invoice.periodEnd).getTime());
    // One calendar month, held to the last day of a shorter month
    // (planPricing.addMonths): paid on 31 Oct, it ends on 30 Nov, not 1 Dec.
    expect(sub.currentPeriodEnd.getTime()).toBe(addMonths(start, 1).getTime());
    // trial_ends_at is left as it was, though the store is no longer on trial.
    expect(sub.trialEndsAt.getTime()).toBe(trialEnd.getTime());

    const paid = await db.BillingInvoice.findByPk(invoice.id);
    expect(paid).toMatchObject({ status: 'paid', paymentSource: 'manual' });
    expect((await accessFor(store.wid)).billing.phase).toBe('ok');
    const plans = (await request(app).get(`/api/v1/workspaces/${store.wid}/billing/plans`).set(store.H)).body;
    expect(plans.planChange).toBe('support');
  });

  it('a trial that ended 10 days ago pays the same way, and the restriction lifts at once', async () => {
    const store = await newStore();
    const admin = await makePlatformUser('admin');
    await lapseTrial(store.wid);
    env.billing.restrictions = 'enforce';
    expect((await request(app).get(`/api/v1/store/${store.wid}`)).status).toBe(423);

    await payByTransfer(store, admin);
    const sub = await subscriptionOf(store.wid);
    expect(sub.status).toBe('active');
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 27 * DAY_MS);
    expect((await accessFor(store.wid)).restricted).toBe(false);
    expect((await request(app).get(`/api/v1/store/${store.wid}`)).status).toBe(200);
  });

  it('a draft (REQUIRE_SUBSCRIPTION_TO_GO_LIVE on) can pay instead of starting its trial, and then sells', async () => {
    env.signup.requireSubscription = true;
    const store = await newStore('Draft Store');
    const admin = await makePlatformUser('admin');
    const draft = await subscriptionOf(store.wid);
    expect(draft.status).toBe('draft');
    expect(draft.trialEndsAt).toBeNull();
    expect((await accessFor(store.wid)).draft).toBe(true);

    // Building is open to a draft; selling is not.
    const { variant } = await createProductWithVariant(store.owner.accessToken, store.wid, { stock: 5 });
    const placeOrder = () =>
      request(app)
        .post(`/api/v1/workspaces/${store.wid}/orders`)
        .set(store.H)
        .set('Idempotency-Key', `o-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        .send({
          items: [{ variantId: variant.id, quantity: 1 }],
          contact: { fullName: 'Buyer', phone: '01000002222' },
          shippingAddress: { country: 'EG', city: 'Cairo', addressLine: '1 A St' },
          paymentMethod: 'cod',
        });
    const refused = await placeOrder();
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('SUBSCRIPTION_REQUIRED');

    expect((await request(app).post(`/api/v1/workspaces/${store.wid}/billing/plan`).set(store.H).send({ planId: pro.id })).status).toBe(200);
    const invoice = await payByTransfer(store, admin);
    expect(Number(invoice.amount)).toBe(PRO);

    const sub = await subscriptionOf(store.wid);
    expect(sub).toMatchObject({ status: 'active', planId: pro.id });
    expect(sub.currentPeriodStart.getTime()).toBe(new Date(invoice.periodStart).getTime());
    expect((await accessFor(store.wid)).draft).toBe(false);
    // Paying used no trial: the account still has it.
    expect(await db.PlanTrial.count({ where: { userId: store.owner.userId } })).toBe(0);
    expect((await placeOrder()).status).toBe(201);
  });
});
