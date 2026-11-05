'use strict';

// Special terms outside normal plan pricing (billing/specialTermsService):
//
//   POST /admin/workspaces/:workspaceId/special-terms   subscriptions.manage
//
//   { kind: 'free_months',    months, note }            comp months, no charge
//   { kind: 'price_override', priceAmount, charges, note } a price for the next N charges

const { app, request, registerAndActivate, addPlatformKeys, approveReferralCode, makePlatformUser } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const { addMonths } = require('../../src/modules/billing/planPricing');

const DAY_MS = 24 * 60 * 60 * 1000;
const STARTER_MONTHLY = 29900;
const ORIGINAL_MODE = env.billing.restrictions;

beforeEach(async () => {
  env.billing.restrictions = 'enforce';
  await billingService.seedDefaultPlans();
});

afterAll(() => {
  env.billing.restrictions = ORIGINAL_MODE;
});

async function setup(referralCode) {
  const owner = await registerAndActivate();
  const res = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'Special Store', referralCode });
  const wid = res.body.workspace.id;
  const starter = await db.Plan.findOne({ where: { key: 'starter' } });
  await db.Subscription.update({ planId: starter.id }, { where: { workspaceId: wid } });
  return { wid, H: { Authorization: `Bearer ${owner.accessToken}` } };
}

const grant = (actor, wid, body) => request(app).post(`/api/v1/admin/workspaces/${wid}/special-terms`).set(actor.H).send(body);
const createCharge = (admin, wid) => request(app).post(`/api/v1/admin/workspaces/${wid}/charges`).set(admin.H);
const pay = (admin, chargeId, amountReceived) =>
  request(app).post(`/api/v1/admin/charges/${chargeId}/record-payment`).set(admin.H).send({ amountReceived });
const subOf = (wid) => db.Subscription.findOne({ where: { workspaceId: wid } });

describe('granting special terms', () => {
  it('is kept to subscriptions.manage, and every grant needs a note', async () => {
    const { wid } = await setup();
    const agent = await makePlatformUser('agent');
    expect((await grant(agent, wid, { kind: 'free_months', months: 1, note: 'Promo' })).status).toBe(403);

    const admin = await makePlatformUser('admin');
    const invalid = [
      { kind: 'free_months', months: 1 },
      { kind: 'free_months', months: 1, note: ' ' },
      { kind: 'free_months', months: 0, note: 'x' },
      { kind: 'free_months', months: 1, priceAmount: 100, note: 'x' },
      { kind: 'price_override', priceAmount: 100, note: 'x' },
      { kind: 'price_override', priceAmount: -1, charges: 1, note: 'x' },
      { kind: 'lifetime', note: 'x' },
    ];
    for (const body of invalid) {
      const res = await grant(admin, wid, body);
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 422]);
    }
    expect(await db.SubscriptionTerm.count()).toBe(0);
  });
});

describe('free months', () => {
  it('pushes the period end out with no charge, and the next charge starts after it', async () => {
    const { wid } = await setup();
    const admin = await makePlatformUser('admin');
    // Paid up for one month first.
    const first = (await createCharge(admin, wid)).body.charge;
    await pay(admin, first.id, STARTER_MONTHLY);
    const paidEnd = new Date((await subOf(wid)).currentPeriodEnd);

    const res = await grant(admin, wid, { kind: 'free_months', months: 2, note: 'Launch promo: 2 months free' });
    expect(res.status).toBe(201);
    expect(res.body.term).toMatchObject({ kind: 'free_months', months: 2, active: true, note: 'Launch promo: 2 months free' });
    expect(new Date(res.body.term.startsAt).getTime()).toBe(paidEnd.getTime());
    const compEnd = addMonths(paidEnd, 2);
    expect(new Date(res.body.term.endsAt).getTime()).toBe(compEnd.getTime());

    // No charge was created for the comped months.
    expect(await db.BillingInvoice.count({ where: { workspaceId: wid } })).toBe(1);
    expect(new Date((await subOf(wid)).currentPeriodEnd).getTime()).toBe(compEnd.getTime());
    expect(res.body.specialTerms).toHaveLength(1);

    const next = (await createCharge(admin, wid)).body.charge;
    expect(new Date(next.periodStart).getTime()).toBe(compEnd.getTime());
    expect(next.grossAmount).toBe(STARTER_MONTHLY);

    const [audit] = await db.AuditLog.findAll({ where: { action: 'subscription.special_terms_grant' } });
    expect(audit).toMatchObject({
      actorUserId: admin.userId,
      workspaceId: null,
      entityType: 'SubscriptionTerm',
      afterState: { kind: 'free_months', months: 2, note: 'Launch promo: 2 months free' },
      metadata: { workspaceId: wid },
    });
  });

  it('forgives a lapsed gap, makes the subscription active and lifts the restriction', async () => {
    const { wid, H } = await setup();
    const admin = await makePlatformUser('admin');
    await db.Subscription.update(
      { status: 'past_due', currentPeriodEnd: new Date(Date.now() - 10 * DAY_MS) },
      { where: { workspaceId: wid } }
    );
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(423);

    const before = Date.now();
    const res = await grant(admin, wid, { kind: 'free_months', months: 1, note: 'Goodwill after outage' });
    expect(new Date(res.body.term.startsAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const sub = await subOf(wid);
    expect(sub.status).toBe('active');
    expect((await request(app).get(`/api/v1/store/${wid}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/workspaces/${wid}/access`).set(H)).body.access.restricted).toBe(false);
  });

  it('moves an open charge past the comped months instead of billing them', async () => {
    const { wid } = await setup();
    const admin = await makePlatformUser('admin');
    const open = (await createCharge(admin, wid)).body.charge;

    const res = await grant(admin, wid, { kind: 'free_months', months: 3, note: 'Bundle with hardware' });
    const moved = await db.BillingInvoice.findByPk(open.id);
    expect(moved.status).toBe('pending');
    expect(new Date(moved.periodStart).getTime()).toBe(new Date(res.body.term.endsAt).getTime());
    expect(new Date(moved.periodEnd).getTime()).toBe(addMonths(new Date(res.body.term.endsAt), 1).getTime());
  });
});

describe('a price override', () => {
  it('prices the next N charges, with the referral discount and commission on the overridden price', async () => {
    const admin = await makePlatformUser('admin');
    await addPlatformKeys(admin.userId, ['agents.create']);
    const person = await registerAndActivate();
    const made = await request(app)
      .post('/api/v1/admin/agents')
      .set(admin.H)
      .send({ email: person.email, firstCode: { code: 'BUNDLE10', discountType: 'percentage', discountValue: 1000 } })
      .expect(201);
    await approveReferralCode(made.body.code.id);
    const { wid, H } = await setup('BUNDLE10');

    const res = await grant(admin, wid, { kind: 'price_override', priceAmount: 20000, charges: 1, note: 'Bundle deal: 200 for the first month' });
    expect(res.status).toBe(201);
    expect(res.body.term).toMatchObject({ kind: 'price_override', priceAmount: 20000, currency: 'USD', chargesTotal: 1, chargesLeft: 1, active: true });
    // Every preview shows it.
    expect(res.body.nextCharge).toMatchObject({ grossAmount: 20000, discountAmount: 2000, amount: 18000 });
    expect((await request(app).get(`/api/v1/workspaces/${wid}/billing`).set(H)).body.billing.nextCharge).toMatchObject({ grossAmount: 20000 });

    const charge = (await createCharge(admin, wid)).body.charge;
    expect(charge).toMatchObject({ grossAmount: 20000, discountAmount: 2000, amountDue: 18000, referralCode: { code: 'BUNDLE10' } });
    expect(charge.specialTermsId).toBe(res.body.term.id);
    await pay(admin, charge.id, 18000).expect(200);
    const [row] = await db.AgentCommission.findAll({ where: { workspaceId: wid } });
    // 30% of the 18000 actually paid, not of the plan price.
    expect(Number(row.suggestedCommission)).toBe(5400);

    // Used up: the next charge is back at the plan price.
    const term = await db.SubscriptionTerm.findByPk(res.body.term.id);
    expect(term.chargesUsed).toBe(1);
    const after = (await createCharge(admin, wid)).body.charge;
    expect(after).toMatchObject({ grossAmount: STARTER_MONTHLY, specialTermsId: null });

    const list = await request(app).get(`/api/v1/admin/workspaces/${wid}/charges`).set(admin.H);
    expect(list.body.specialTerms[0]).toMatchObject({ id: term.id, active: false, chargesLeft: 0 });
  });

  it('re-prices a charge that is already open, and allows one override at a time', async () => {
    const { wid } = await setup();
    const admin = await makePlatformUser('admin');
    const open = (await createCharge(admin, wid)).body.charge;
    expect(open.grossAmount).toBe(STARTER_MONTHLY);

    const res = await grant(admin, wid, { kind: 'price_override', priceAmount: 9900, charges: 3, note: 'Three discounted months' });
    const repriced = await db.BillingInvoice.findByPk(open.id);
    expect(Number(repriced.grossAmount)).toBe(9900);
    expect(Number(repriced.amount)).toBe(9900);
    expect(repriced.specialTermsId).toBe(res.body.term.id);
    expect(res.body.term).toMatchObject({ chargesUsed: 1, chargesLeft: 2 });
    expect((await db.SubscriptionTerm.findByPk(res.body.term.id)).chargesUsed).toBe(1);

    const second = await grant(admin, wid, { kind: 'price_override', priceAmount: 5000, charges: 1, note: 'Another' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SPECIAL_PRICE_ACTIVE');
  });

  it('is refused on a cancelled subscription', async () => {
    const { wid } = await setup();
    const admin = await makePlatformUser('admin');
    await db.Subscription.update({ status: 'cancelled' }, { where: { workspaceId: wid } });
    const res = await grant(admin, wid, { kind: 'free_months', months: 1, note: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUBSCRIPTION_CANCELLED');
  });
});
