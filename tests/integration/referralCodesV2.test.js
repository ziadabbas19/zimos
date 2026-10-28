'use strict';

// Referral codes of the second kind (modules/referrals, migration 725,
// REFERRAL_CODES_V2_ENABLED): codes with or without an agent, once per
// store / account / email, a use limit that holds under a race, dates,
// audience and restrictions, per-cycle discount and commission schedules,
// the commission basis, agent links (from a code and by hand), the history,
// the simulator, a code entered with a plan switch, and the first kind
// working as before. Charges are paid through the signed billing webhook, as
// in agentReferrals.test.js.

const { app, request, registerAndActivate, makePlatformUser, uniqueEmail } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const billingService = require('../../src/modules/billing/billingService');
const charges = require('../../src/modules/billing/subscriptionChargeService');
const { signPayload, SIGNATURE_HEADER } = require('../../src/modules/billing/gatewaySignature');

const TEST_SECRET = 'test_billing_webhook_secret_0123456789';
const ORIGINAL_SECRET = env.billing.webhookSecret;
const DAY = 24 * 60 * 60 * 1000;

// Starter: 29900 a month / 299000 a year, USD (billingService.DEFAULT_PLANS).
const MONTHLY = 29900;
const YEARLY = 299000;

let admin;
let starter;

const v2 = (on) => {
  env.billing.referralCodesV2.enabled = on;
};

beforeEach(async () => {
  env.billing.webhookSecret = TEST_SECRET;
  await billingService.seedDefaultPlans();
  await db.Plan.update({ maxStores: null }, { where: {} });
  starter = await db.Plan.findOne({ where: { key: 'starter' } });
  admin = await makePlatformUser('admin');
  v2(true);
});

afterEach(() => {
  v2(false);
  env.billing.planSwitch.enabled = false;
});

afterAll(() => {
  env.billing.webhookSecret = ORIGINAL_SECRET;
});

function postWebhook(payload) {
  const raw = JSON.stringify(payload);
  return request(app).post('/api/v1/billing/webhook').type('json').set(SIGNATURE_HEADER, signPayload(raw, TEST_SECRET)).send(raw);
}

const pct = (count, value) => ({ count, type: 'percentage', value });
const rate = (count, rateBp) => ({ count, rateBp });
const both = (discount, commission = []) => ({ monthly: { discount, commission }, yearly: { discount, commission } });

async function makeCode(body) {
  const res = await request(app).post('/api/v1/admin/referral-codes').set(admin.H).send(body);
  if (res.status !== 201) throw new Error(`makeCode failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.code;
}

async function newAgent() {
  const person = await registerAndActivate({ fullName: 'Agent Person' });
  const res = await request(app).post('/api/v1/admin/agents').set(admin.H).send({ email: person.email });
  if (res.status !== 201) throw new Error(`newAgent failed: ${res.status} ${JSON.stringify(res.body)}`);
  return person;
}

/** A person's store, created with `referralCode` (or none), put on Starter `cycle`. Returns the raw response too. */
async function signup(referralCode, { owner = null, cycle = 'monthly', name = 'Coded Store', email } = {}) {
  const person = owner || (await registerAndActivate(email ? { email } : {}));
  const H = { Authorization: `Bearer ${person.accessToken}` };
  const res = await request(app).post('/api/v1/workspaces').set(H).send({ name, ...(referralCode ? { referralCode } : {}) });
  const wid = res.status === 201 ? res.body.workspace.id : null;
  if (wid) await db.Subscription.update({ planId: starter.id, billingCycle: cycle }, { where: { workspaceId: wid } });
  return { owner: person, H, wid, res };
}

const enter = (store, code, extra = {}) =>
  request(app).post(`/api/v1/workspaces/${store.wid}/billing/referral-code`).set(store.H).send({ code, ...extra });

/** Writes the store's next charge and pays it in full through the webhook. */
async function payNext(wid) {
  const { invoice } = await charges.createCharge(wid);
  const res = await postWebhook({ type: 'invoice.paid', data: { invoiceId: invoice.id } });
  if (res.status !== 200) throw new Error(`webhook failed: ${res.status} ${JSON.stringify(res.body)}`);
  return db.BillingInvoice.findByPk(invoice.id);
}

const errorCode = (res) => res.body && res.body.error && res.body.error.code;

describe('flag off: the first kind as before, the second refused', () => {
  it('refuses an agentless code and second-kind settings, and enters a first-kind code as before', async () => {
    v2(false);
    const agentless = await request(app).post('/api/v1/admin/referral-codes').set(admin.H).send({ code: 'NOAGENT' });
    expect([agentless.status, errorCode(agentless)]).toEqual([409, 'REFERRAL_V2_DISABLED']);

    const agent = await newAgent();
    const limited = await request(app).post(`/api/v1/admin/agents/${agent.userId}/codes`).set(admin.H).send({ code: 'LIMIT1', maxUses: 5 });
    expect([limited.status, errorCode(limited)]).toEqual([409, 'REFERRAL_V2_DISABLED']);

    const old = await request(app)
      .post(`/api/v1/admin/agents/${agent.userId}/codes`)
      .set(admin.H)
      .send({ code: 'OLD10', discountType: 'percentage', discountValue: 1000 });
    expect(old.status).toBe(201);
    expect(old.body.code).toMatchObject({ kind: 'legacy', audience: 'any', terms: null, usesCount: 0 });

    // The same owner may still use it on a second store, as before (no once-per rule with the flag off).
    const first = await signup('OLD10');
    const second = await signup('OLD10', { owner: first.owner, name: 'Second Store' });
    expect([first.res.status, second.res.status]).toEqual([201, 201]);
    // Every charge 10% off, as before.
    for (const n of [1, 2]) expect(Number((await payNext(first.wid)).amount)).toBe(MONTHLY - 2990);

    const rows = await db.ReferralCodeRedemption.findAll({ where: { workspaceId: first.wid } });
    expect(rows.map((r) => [r.source, r.singleUse, r.isFirst, r.terms])).toEqual([['signup', false, true, null]]);
    expect((await db.ReferralCode.findOne({ where: { code: 'OLD10' } })).usesCount).toBe(2);
    expect(await db.AgentCommission.count({ where: { workspaceId: first.wid } })).toBe(2);
  });
});

describe('codes with no agent, and the defaults of a new code', () => {
  it('an admin makes a discount-only code: first payment only, new merchants only, no commission', async () => {
    const code = await makeCode({ code: 'welcome', discountType: 'percentage', discountValue: 10000 });
    expect(code).toMatchObject({ code: 'WELCOME', agentId: null, kind: 'schedule', audience: 'new', discountType: 'none', commissionBasis: 'paid', linksAgent: true });
    expect(code.terms.monthly.discount).toEqual([pct(1, 10000)]);
    expect(code.terms.yearly.discount).toEqual([pct(1, 10000)]);

    const store = await signup('WELCOME');
    expect(store.res.status).toBe(201);
    const amounts = [];
    for (const n of [1, 2]) amounts.push(Number((await payNext(store.wid)).amount));
    expect(amounts).toEqual([0, MONTHLY]);
    expect(await db.AgentCommission.count()).toBe(0);
    expect(await db.AgentLink.count()).toBe(0);
  });
});

describe('once per store, account and email', () => {
  it('refuses the same account, and another spelling of the same Gmail, on another store', async () => {
    await makeCode({ code: 'ONCE', audience: 'any', terms: both([pct(1, 5000)]) });
    const tag = Date.now();
    const a = await signup('ONCE', { email: `ab.cd${tag}@gmail.com` });
    expect(a.res.status).toBe(201);

    // The same account, a second store: refused, and the store is not made.
    const again = await signup('ONCE', { owner: a.owner, name: 'Second' });
    expect([again.res.status, errorCode(again.res), again.res.body.error.details]).toEqual([422, 'REFERRAL_CODE_ALREADY_USED', { by: 'account' }]);

    // Another account whose email is the same mailbox.
    const b = await signup('ONCE', { email: `abcd${tag}+2@googlemail.com` });
    expect([b.res.status, errorCode(b.res), b.res.body.error.details]).toEqual([422, 'REFERRAL_CODE_ALREADY_USED', { by: 'email' }]);

    // The same store entering it again changes nothing.
    const same = await enter(a, 'once');
    expect([same.status, same.body.attached]).toEqual([200, false]);

    // Someone else entirely.
    const c = await signup('ONCE');
    expect(c.res.status).toBe(201);
    expect((await db.ReferralCode.findOne({ where: { code: 'ONCE' } })).usesCount).toBe(2);
  });
});

describe('the use limit', () => {
  it('two stores entering the last use at once: one gets it, the other is told the code is used up', async () => {
    const code = await makeCode({ code: 'LAST1', audience: 'any', maxUses: 1, terms: both([pct(1, 5000)]) });
    const one = await signup(null);
    const two = await signup(null);
    const results = await Promise.all([enter(one, 'LAST1'), enter(two, 'LAST1')]);
    const outcome = results.map((r) => (r.status === 201 ? 'ok' : errorCode(r))).sort();
    expect(outcome).toEqual(['REFERRAL_CODE_LIMIT_REACHED', 'ok']);

    const row = await db.ReferralCode.findByPk(code.id);
    expect(row.usesCount).toBe(1);
    const page = await request(app).get(`/api/v1/admin/referral-codes/${code.id}`).set(admin.H);
    expect(page.body.code).toMatchObject({ state: 'full', usesCount: 1, maxUses: 1 });

    // The store that got it keeps its discount.
    const winner = results[0].status === 201 ? one : two;
    expect(Number((await payNext(winner.wid)).amount)).toBe(MONTHLY / 2);
    const late = await signup('LAST1');
    expect(errorCode(late.res)).toBe('REFERRAL_CODE_LIMIT_REACHED');
  });
});

describe('dates, audience and restrictions', () => {
  it('each refusal has its own code', async () => {
    const growth = await db.Plan.findOne({ where: { key: 'growth' } });
    await makeCode({ code: 'PAST', audience: 'any', endsAt: new Date(Date.now() - DAY).toISOString() });
    await makeCode({ code: 'SOON', audience: 'any', startsAt: new Date(Date.now() + DAY).toISOString() });
    await makeCode({ code: 'OLDONLY', audience: 'existing' });
    await makeCode({ code: 'NEWONLY', audience: 'new' });
    await makeCode({ code: 'YEARONLY', audience: 'any', allowedCycles: ['yearly'] });
    await makeCode({ code: 'OTHERPLAN', audience: 'any', allowedPlanIds: [growth.id] });
    await makeCode({ code: 'BIGPLAN', audience: 'any', minPriceAmount: 1000000, minPriceCurrency: 'USD' });

    const store = await signup(null);
    const codeOf = async (code, extra) => errorCode(await enter(store, code, extra));
    expect(await codeOf('PAST')).toBe('REFERRAL_CODE_EXPIRED');
    expect(await codeOf('SOON')).toBe('REFERRAL_CODE_NOT_STARTED');
    expect(await codeOf('OLDONLY')).toBe('REFERRAL_CODE_EXISTING_MERCHANTS_ONLY');
    expect(await codeOf('YEARONLY')).toBe('REFERRAL_CODE_NOT_FOR_CYCLE');
    expect(await codeOf('YEARONLY', { billingCycle: 'yearly' })).toBeUndefined();

    // An owner who has paid before is an existing merchant.
    const paid = await signup(null);
    await payNext(paid.wid);
    expect(errorCode(await enter(paid, 'NEWONLY'))).toBe('REFERRAL_CODE_NEW_MERCHANTS_ONLY');
    expect((await enter(paid, 'OLDONLY')).status).toBe(201);
    // At sign-up a first store is a new merchant.
    expect(errorCode((await signup('OLDONLY')).res)).toBe('REFERRAL_CODE_EXISTING_MERCHANTS_ONLY');

    const other = await signup(null);
    expect(errorCode(await enter(other, 'BIGPLAN'))).toBe('REFERRAL_CODE_BELOW_MIN_PRICE');
    expect(errorCode(await enter(other, 'OTHERPLAN'))).toBe('REFERRAL_CODE_NOT_FOR_PLAN');
    // Judged against the plan being chosen with it.
    expect((await enter(other, 'OTHERPLAN', { planId: growth.id })).status).toBe(201);
  });
});

describe('schedules per cycle', () => {
  it('monthly: free, then 20% for three, then full; yearly: half off once', async () => {
    await makeCode({
      code: 'STEPS',
      audience: 'any',
      terms: { monthly: { discount: [pct(1, 10000), pct(3, 2000)], commission: [] }, yearly: { discount: [pct(1, 5000)], commission: [] } },
    });
    const monthly = await signup('STEPS');
    const amounts = [];
    const numbers = [];
    for (let i = 0; i < 5; i += 1) {
      const inv = await payNext(monthly.wid);
      amounts.push(Number(inv.amount));
      numbers.push(inv.referralPaymentNo);
    }
    expect(amounts).toEqual([0, 23920, 23920, 23920, MONTHLY]);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    const redemption = await db.ReferralCodeRedemption.findOne({ where: { workspaceId: monthly.wid } });
    const first = await db.BillingInvoice.findOne({ where: { workspaceId: monthly.wid, referralPaymentNo: 1 } });
    expect(redemption.firstInvoiceId).toBe(first.id);

    const yearly = await signup('STEPS', { cycle: 'yearly' });
    expect([Number((await payNext(yearly.wid)).amount), Number((await payNext(yearly.wid)).amount)]).toEqual([YEARLY / 2, YEARLY]);
  });
});

describe('commission: links from codes, schedules and basis', () => {
  it('on what was paid by default, on the list price when set, and nothing past the schedule', async () => {
    const agent = await newAgent();
    const terms = both([pct(1, 5000)], [rate(2, 3000)]);
    await makeCode({ code: 'PAIDB', agentId: agent.userId, audience: 'any', terms });
    await makeCode({ code: 'LISTB', agentId: agent.userId, audience: 'any', terms, commissionBasis: 'list' });

    const paid = await signup('PAIDB');
    const list = await signup('LISTB');
    for (let i = 0; i < 3; i += 1) {
      await payNext(paid.wid);
      await payNext(list.wid);
    }
    const rows = async (wid) =>
      (await db.AgentCommission.findAll({ where: { workspaceId: wid }, order: [['paymentNo', 'ASC']] })).map((r) => [
        r.paymentNo,
        r.commissionBasis,
        Number(r.baseAmount),
        Number(r.amountPaid),
        Number(r.suggestedCommission),
      ]);
    // Payment 1 half off (14950 paid), payment 2 full; the schedule covers two payments.
    expect(await rows(paid.wid)).toEqual([
      [1, 'paid', 14950, 14950, 4485],
      [2, 'paid', MONTHLY, MONTHLY, 8970],
    ]);
    expect(await rows(list.wid)).toEqual([
      [1, 'list', MONTHLY, 14950, 8970],
      [2, 'list', MONTHLY, MONTHLY, 8970],
    ]);
    const link = await db.AgentLink.findOne({ where: { workspaceId: paid.wid } });
    expect(link).toMatchObject({ source: 'code', agentId: agent.userId, legacy: false, endedAt: null });
  });

  it('a store already linked keeps its agent; the console links by hand, moves and ends it, all audited', async () => {
    const agentA = await newAgent();
    const agentB = await newAgent();
    await makeCode({ code: 'AGENTA', agentId: agentA.userId, audience: 'any', terms: both([], [rate(null, 3000)]) });

    const store = await signup(null);
    const linked = await request(app)
      .post(`/api/v1/admin/workspaces/${store.wid}/agent-links`)
      .set(admin.H)
      .send({ agentId: agentB.userId, terms: { monthly: [rate(null, 2000)], yearly: [rate(null, 1000)] }, note: 'Brought by phone' });
    expect(linked.status).toBe(201);
    expect(linked.body.link).toMatchObject({ source: 'manual', open: true, code: null, agent: { id: agentB.userId } });

    // A's code entered afterwards: the store stays with B.
    expect((await enter(store, 'AGENTA')).status).toBe(201);
    await payNext(store.wid);
    const [row] = await db.AgentCommission.findAll({ where: { workspaceId: store.wid } });
    expect([row.agentId, row.codeId, Number(row.suggestedCommission)]).toEqual([agentB.userId, null, 5980]);

    // Moved to A by hand: B's link ends as replaced.
    const moved = await request(app)
      .post(`/api/v1/admin/workspaces/${store.wid}/agent-links`)
      .set(admin.H)
      .send({ agentId: agentA.userId, terms: { monthly: [rate(1, 5000)], yearly: [rate(1, 5000)] } });
    expect(moved.status).toBe(201);
    const history = await request(app).get(`/api/v1/admin/workspaces/${store.wid}/referrals`).set(admin.H);
    expect(history.body.links.map((l) => [l.agent.id, l.open, l.endReason])).toEqual([
      [agentA.userId, true, null],
      [agentB.userId, false, 'replaced'],
    ]);
    await payNext(store.wid);
    // Its schedule is one payment; the third earns nothing.
    await payNext(store.wid);
    expect((await db.AgentCommission.findAll({ where: { workspaceId: store.wid }, order: [['paidAt', 'ASC']] })).map((r) => r.agentId)).toEqual([agentB.userId, agentA.userId]);

    const end = await request(app).post(`/api/v1/admin/agent-links/${moved.body.link.id}/end`).set(admin.H).send({});
    expect([end.status, end.body.link.endReason]).toEqual([200, 'ended']);
    const actions = (await db.AuditLog.findAll({ where: { entityType: 'AgentLink' } })).map((a) => `${a.action}:${a.entityId === moved.body.link.id ? 'A' : 'B'}`);
    expect(actions.sort()).toEqual(['agent_link.create:A', 'agent_link.create:B', 'agent_link.end:A', 'agent_link.end:B']);
  });
});

describe('a code of the first kind given a schedule (FREE100)', () => {
  it('the stores that entered it follow the schedule from their next payment, each at its own number', async () => {
    v2(false);
    const agent = await newAgent();
    const made = await request(app)
      .post(`/api/v1/admin/agents/${agent.userId}/codes`)
      .set(admin.H)
      .send({ code: 'FREE100', discountType: 'percentage', discountValue: 10000, commissionRateBp: 0 });
    expect(made.status).toBe(201);
    const early = await signup('FREE100');
    const trialing = await signup('FREE100');
    // As before: 100% off every charge.
    expect([Number((await payNext(early.wid)).amount), Number((await payNext(early.wid)).amount)]).toEqual([0, 0]);

    v2(true);
    const converted = await request(app)
      .patch(`/api/v1/admin/referral-codes/${made.body.code.id}`)
      .set(admin.H)
      .send({ terms: both([pct(1, 10000)], [rate(null, 1000)]) });
    expect(converted.status).toBe(200);
    // Its first-kind discount and rate are kept, for the flag turned off again.
    expect(converted.body.code).toMatchObject({ kind: 'schedule', discountType: 'percentage', discountValue: 10000, commissionRateBp: 0 });

    // The trialing store's first payment is still free; after it, full price. The early store has had its free one.
    expect([Number((await payNext(trialing.wid)).amount), Number((await payNext(trialing.wid)).amount)]).toEqual([0, MONTHLY]);
    expect(Number((await payNext(early.wid)).amount)).toBe(MONTHLY);
    // Its agent's old-kind link earns at the new schedule's rate (10% of what was paid), no longer the code's 0%.
    const earned = (await db.AgentCommission.findAll({ where: { workspaceId: trialing.wid }, order: [['paidAt', 'ASC']] })).map((r) => Number(r.suggestedCommission));
    expect(earned).toEqual([0, 2990]);

    // Switched off again: the first kind as before, 100% off.
    v2(false);
    expect(Number((await payNext(trialing.wid)).amount)).toBe(0);
    v2(true);
    const audit = await db.AuditLog.findOne({ where: { action: 'referral_code.update', entityId: made.body.code.id } });
    expect(audit.beforeState.terms).toBeNull();
    expect(audit.afterState.terms.monthly.discount).toEqual([pct(1, 10000)]);
  });
});

describe('history, the code page and the bell', () => {
  it('every code a store and an account entered, the first marked; the code page lists and searches its stores', async () => {
    await makeCode({ code: 'FIRSTONE', audience: 'any', terms: both([pct(1, 5000)]) });
    await makeCode({ code: 'SECONDONE', audience: 'any', terms: both([pct(1, 1000)]) });
    const store = await signup('FIRSTONE', { name: 'Findable Bakery' });
    // A second code is refused while the first still has a payment to discount.
    expect(errorCode(await enter(store, 'SECONDONE'))).toBe('REFERRAL_CODE_ALREADY_SET');
    await payNext(store.wid);
    expect((await enter(store, 'SECONDONE')).status).toBe(201);

    const ws = await request(app).get(`/api/v1/admin/workspaces/${store.wid}/referrals`).set(admin.H);
    expect(ws.body.redemptions.map((r) => [r.code.code, r.isFirst, r.current, r.endReason, r.paymentsMade])).toEqual([
      ['SECONDONE', false, true, null, 0],
      ['FIRSTONE', true, false, 'replaced', 1],
    ]);
    expect(ws.body.redemptions[1].firstInvoice).toMatchObject({ discountAmount: 14950, amount: 14950 });
    const user = await request(app).get(`/api/v1/admin/users/${store.owner.userId}/referrals`).set(admin.H);
    expect(user.body.redemptions).toHaveLength(2);

    const firstId = (await db.ReferralCode.findOne({ where: { code: 'FIRSTONE' } })).id;
    const other = await signup('FIRSTONE', { name: 'Another Shop' });
    expect(other.res.status).toBe(201);
    const found = await request(app).get(`/api/v1/admin/referral-codes/${firstId}/redemptions?q=bakery`).set(admin.H);
    expect(found.body.redemptions.map((r) => r.workspace.name)).toEqual(['Findable Bakery']);
    const current = await request(app).get(`/api/v1/admin/referral-codes/${firstId}/redemptions?status=current`).set(admin.H);
    expect(current.body.redemptions.map((r) => r.workspace.name)).toEqual(['Another Shop']);

    const bell = await db.sequelize.query("SELECT title FROM platform_notifications WHERE type = 'referral_signup' ORDER BY created_at", { type: db.Sequelize.QueryTypes.SELECT });
    expect(bell.map((b) => b.title)).toEqual(['A store used the code FIRSTONE', 'A store used the code SECONDONE', 'A store used the code FIRSTONE']);
  });

  it('the code page warns what switching it off costs; switched off, a trial loses the discount', async () => {
    const code = await makeCode({ code: 'OFFSOON', audience: 'any', terms: both([pct(1, 5000)]) });
    const trialing = await signup('OFFSOON');
    const page = await request(app).get(`/api/v1/admin/referral-codes/${code.id}`).set(admin.H);
    expect(page.body.impact).toEqual({ currentStores: 1, trialingUnpaid: 1 });

    const off = await request(app).patch(`/api/v1/admin/referral-codes/${code.id}`).set(admin.H).send({ active: false });
    expect(off.body.code.state).toBe('inactive');
    expect(Number((await payNext(trialing.wid)).amount)).toBe(MONTHLY);
  });

  it('the list filters by agent, state and audience, and searches', async () => {
    const agent = await newAgent();
    await makeCode({ code: 'LISTA', agentId: agent.userId, audience: 'existing' });
    await makeCode({ code: 'LISTB', audience: 'new', label: 'Cairo fair' });
    const ask = (q) => request(app).get(`/api/v1/admin/referral-codes?${q}`).set(admin.H);
    expect((await ask('agentId=none')).body.codes.map((c) => c.code)).toEqual(['LISTB']);
    expect((await ask(`agentId=${agent.userId}`)).body.codes.map((c) => [c.code, c.agent.id])).toEqual([['LISTA', agent.userId]]);
    expect((await ask('audience=existing')).body.codes.map((c) => c.code)).toEqual(['LISTA']);
    expect((await ask('q=cairo')).body.codes.map((c) => c.code)).toEqual(['LISTB']);
    expect((await ask('state=active')).body.total).toBe(2);
  });
});

describe('the simulator', () => {
  it('the first twelve payments: list, discount, paid, commission, platform', async () => {
    const res = await request(app)
      .post('/api/v1/admin/referral-codes/simulate')
      .set(admin.H)
      .send({ planId: starter.id, billingCycle: 'monthly', terms: both([pct(1, 10000), pct(3, 2000)], [rate(1, 10000), rate(12, 3000)]) });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(12);
    expect(res.body.rows[0]).toEqual({ paymentNo: 1, listPrice: MONTHLY, discount: MONTHLY, merchantPays: 0, commissionRateBp: 10000, commission: 0, platformNet: 0 });
    expect(res.body.rows[1]).toMatchObject({ merchantPays: 23920, commission: 7176, platformNet: 16744 });
    const bad = await request(app).post('/api/v1/admin/referral-codes/simulate').set(admin.H).send({ planId: starter.id, billingCycle: 'monthly', terms: both([pct(null, 100), pct(1, 100)]) });
    expect(bad.status).toBe(422);
  });
});

describe('permissions and the audit', () => {
  it('an agent reads nothing here and writes nothing; every change to a code is audited before and after', async () => {
    const agent = await newAgent();
    const AH = { Authorization: `Bearer ${agent.accessToken}` };
    expect((await request(app).get('/api/v1/admin/referral-codes').set(AH)).status).toBe(403);
    expect((await request(app).post('/api/v1/admin/referral-codes').set(AH).send({ code: 'MINE1' })).status).toBe(403);

    const code = await makeCode({ code: 'AUDITED', audience: 'any' });
    await request(app).patch(`/api/v1/admin/referral-codes/${code.id}`).set(admin.H).send({ maxUses: 5, agentId: agent.userId });
    const entry = await db.AuditLog.findOne({ where: { action: 'referral_code.update', entityId: code.id } });
    expect([entry.actorUserId, entry.beforeState.maxUses, entry.afterState.maxUses, entry.beforeState.agentId, entry.afterState.agentId]).toEqual([admin.userId, null, 5, null, agent.userId]);
  });
});

describe('a one-time benefit', () => {
  it('extra trial days on a trial running now', async () => {
    await makeCode({ code: 'TRIAL7', audience: 'any', grantType: 'trial_days', grantValue: 7 });
    const plain = await signup(null);
    const coded = await signup('TRIAL7');
    const end = async (wid) => new Date((await db.Subscription.findOne({ where: { workspaceId: wid } })).trialEndsAt).getTime();
    const gained = (await end(coded.wid)) - (await end(plain.wid));
    expect(Math.round(gained / DAY)).toBe(7);
    expect((await db.ReferralCodeRedemption.findOne({ where: { workspaceId: coded.wid } })).grantAppliedAt).not.toBeNull();
  });
});

describe('a code entered with a plan switch', () => {
  it('previews the price before and after, then prices the switch charge with it', async () => {
    env.billing.planSwitch.enabled = true;
    const basic = await db.Plan.create({ key: 'basic-egp', name: 'Basic', monthlyPriceAmount: 30000, yearlyPriceAmount: 300000, currency: 'EGP', isPublic: true, isActive: true });
    const pro = await db.Plan.create({ key: 'pro-egp', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000, currency: 'EGP', isPublic: true, isActive: true });
    await db.PaymentMethod.create({ kind: 'manual', code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10, enabled: true, accountNumber: 'zimos@instapay' });
    await makeCode({ code: 'UPGRADE50', audience: 'existing', allowedPlanIds: [pro.id], terms: both([pct(1, 5000)]) });
    await makeCode({ code: 'NEWBIE', audience: 'new' });

    const store = await signup(null);
    const now = Date.now();
    await db.Subscription.update(
      { planId: basic.id, status: 'active', currentPeriodStart: new Date(now - 10 * DAY), currentPeriodEnd: new Date(now + 20 * DAY), trialEndsAt: null },
      { where: { workspaceId: store.wid } }
    );
    const sub = await db.Subscription.findOne({ where: { workspaceId: store.wid } });
    await db.BillingInvoice.create({
      workspaceId: store.wid, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, amountPaid: 30000, currency: 'EGP',
      status: 'paid', paymentSource: 'manual', paidAt: new Date(now - 10 * DAY), periodStart: new Date(now - 10 * DAY), periodEnd: new Date(now + 20 * DAY),
    });

    const base = `/api/v1/workspaces/${store.wid}/billing/plan-switch`;
    const refused = await request(app).post(`${base}/preview`).set(store.H).send({ planId: pro.id, referralCode: 'NEWBIE' });
    expect(errorCode(refused)).toBe('REFERRAL_CODE_NEW_MERCHANTS_ONLY');
    const notForBasic = await request(app).post(`${base}/preview`).set(store.H).send({ planId: basic.id, billingCycle: 'yearly', referralCode: 'UPGRADE50' });
    expect(errorCode(notForBasic)).toBe('REFERRAL_CODE_NOT_FOR_PLAN');

    const preview = await request(app).post(`${base}/preview`).set(store.H).send({ planId: pro.id, referralCode: 'upgrade50' });
    expect(preview.status).toBe(200);
    expect(preview.body.preview.referralCode).toMatchObject({ appliesTo: 'charge_now', before: 60000, after: 30000, currency: 'EGP' });
    expect(preview.body.preview.referralCode.schedule.monthly.slice(0, 2)).toEqual([
      { paymentNo: 1, listPrice: 60000, discount: 30000, merchantPays: 30000 },
      { paymentNo: 2, listPrice: 60000, discount: 0, merchantPays: 60000 },
    ]);

    const started = await request(app).post(base).set(store.H).send({ planId: pro.id, referralCode: 'UPGRADE50', expectedAmount: 30000 });
    expect(started.status).toBe(201);
    expect(started.body.invoice).toMatchObject({ amountDue: 30000 });
    const redemption = await db.ReferralCodeRedemption.findOne({ where: { workspaceId: store.wid } });
    expect([redemption.source, redemption.merchantKind]).toEqual(['plan_switch', 'existing']);
  });
});
