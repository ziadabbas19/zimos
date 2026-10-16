'use strict';

// A merchant changing plan by themselves (billing/planSwitchService):
// preview, start, replace, cancel and what is refused, on an in-memory
// stand-in for the models: no database. The HTTP routes with a real
// database are in tests/integration/planSwitch.test.js.

jest.mock('../../src/db/models', () => require('../helpers/fakeBillingDb').create());
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn(async () => null) }));
jest.mock('../../src/modules/referrals/commissionService', () => ({
  recordForPaidInvoice: jest.fn(async () => null),
  voidForInvoice: jest.fn(async () => null),
}));
jest.mock('../../src/modules/billing/specialTermsService', () => ({
  activePriceOverride: jest.fn(async () => null),
  compCoveredUntil: jest.fn(async () => null),
}));
jest.mock('../../src/modules/billing/paymentMethodService', () => ({ anyOffered: jest.fn(async (currency) => currency === 'EGP') }));
jest.mock('../../src/modules/billing/merchantPlansService', () => {
  const db = require('../../src/db/models');
  return {
    listPlans: jest.fn(async () => ({ listed: true })),
    changePlan: jest.fn(async () => ({ changed: true, plans: { listed: true } })),
    requestPlanMove: jest.fn(async () => ({ created: true, invoice: { id: 'move' }, plans: { listed: true } })),
    cancelPlanMove: jest.fn(async () => ({ cancelled: false, plans: { listed: true } })),
    serializeInvoice: (invoice) => ({ id: invoice.id, status: invoice.status, amountDue: Number(invoice.amount), currency: invoice.currency, targetPlanId: invoice.targetPlanId }),
    lockPendingCharge: jest.fn(async (workspaceId) => db.BillingInvoice.findOne({ where: { workspaceId, status: 'pending' } })),
  };
});
jest.mock('../../src/core/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../../src/db/models');
const env = require('../../src/config/env');
const specialTerms = require('../../src/modules/billing/specialTermsService');
const merchantPlans = require('../../src/modules/billing/merchantPlansService');
const switches = require('../../src/modules/billing/planSwitchService');

const DAY = 24 * 60 * 60 * 1000;
const WID = 'workspace-1';
const req = { user: { id: 'owner-1' } };

let basic;
let pro;
let free;
let dollar;
let dollarPro;

beforeEach(async () => {
  db.reset();
  jest.clearAllMocks();
  env.billing.planSwitch.enabled = true;
  basic = await db.Plan.create({ key: 'basic', name: 'Basic', monthlyPriceAmount: 30000, yearlyPriceAmount: 300000 });
  pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000 });
  free = await db.Plan.create({ key: 'free', name: 'Free', monthlyPriceAmount: 0, yearlyPriceAmount: 0 });
  dollar = await db.Plan.create({ key: 'usd', name: 'Dollar', monthlyPriceAmount: 2000, yearlyPriceAmount: 20000, currency: 'USD' });
  dollarPro = await db.Plan.create({ key: 'usd-pro', name: 'Dollar Pro', monthlyPriceAmount: 5000, yearlyPriceAmount: 50000, currency: 'USD' });
});

afterEach(() => {
  env.billing.planSwitch.enabled = false;
});

// Ten days into a thirty-day month: twenty days left.
async function store({ planId, ended = false, extra = {} } = {}) {
  const start = new Date(Date.now() - (ended ? 40 : 10) * DAY);
  return db.Subscription.create({
    workspaceId: WID,
    planId: planId || basic.id,
    billingCycle: 'monthly',
    status: 'active',
    currentPeriodStart: start,
    currentPeriodEnd: new Date(start.getTime() + 30 * DAY),
    ...extra,
  });
}

const pendingOf = () => db.BillingInvoice.findAll({ where: { workspaceId: WID, status: 'pending' } });
const openOf = () => db.PlanSwitch.findAll({ where: { workspaceId: WID, status: ['pending', 'scheduled'] } });

describe('the flag', () => {
  it('off: no preview and no start, as before; cancelling still works', async () => {
    env.billing.planSwitch.enabled = false;
    await store();
    await expect(switches.preview(WID, { planId: pro.id })).rejects.toMatchObject({ code: 'PLAN_SWITCH_DISABLED', statusCode: 404 });
    await expect(switches.start(WID, { planId: pro.id }, req)).rejects.toMatchObject({ code: 'PLAN_SWITCH_DISABLED' });
    expect(await switches.cancel(WID, req)).toMatchObject({ cancelled: false });
    expect(await db.BillingInvoice.count()).toBe(0);
  });
});

describe('an upgrade', () => {
  it('previews the new plan at its full price now, or at the end of the period with nothing due now', async () => {
    const sub = await store();
    const { preview } = await switches.preview(WID, { planId: pro.id });
    expect(preview).toMatchObject({
      kind: 'upgrade',
      reason: 'upgrade',
      timing: 'now',
      timings: ['now', 'period_end'],
      effective: 'on_payment',
      effectiveAt: null,
      amountDue: 60000,
      currency: 'EGP',
      proration: null,
      currentPeriod: { endsAt: sub.currentPeriodEnd, remainingDays: 20 },
      nextRenewal: { at: null, amount: 60000, billingCycle: 'monthly' },
      payable: true,
      blockedBy: null,
      replaces: null,
      trial: false,
    });
    expect(preview.options.now).toMatchObject({ effective: 'on_payment', amountDue: 60000, payable: true });
    expect(preview.options.period_end).toMatchObject({
      effective: 'period_end',
      effectiveAt: sub.currentPeriodEnd,
      amountDue: 0,
      chargeExpiry: null,
      nextRenewal: { at: sub.currentPeriodEnd, amount: 60000 },
      payable: null,
      blockedBy: null,
    });
    // Asking for the other timing describes it at the top.
    expect((await switches.preview(WID, { planId: pro.id, timing: 'period_end' })).preview).toMatchObject({ timing: 'period_end', effective: 'period_end', amountDue: 0 });
    expect(await db.BillingInvoice.count()).toBe(0);
  });

  it('the next renewal has a date for every kind but one whose period starts on payment', async () => {
    const sub = await store();
    const up = (await switches.preview(WID, { planId: pro.id })).preview;
    expect(up.nextRenewal).toMatchObject({ at: null, amount: 60000, currency: 'EGP', billingCycle: 'monthly' });
    // The plan the store is on: its renewal as it stands.
    expect((await switches.preview(WID, { planId: basic.id })).preview).toMatchObject({ kind: 'none', nextRenewal: { at: sub.currentPeriodEnd, amount: 30000 } });
    // A free plan has no renewal.
    expect((await switches.preview(WID, { planId: free.id })).preview).toMatchObject({ kind: 'scheduled', nextRenewal: null });
    // From a free plan: a move, whose period starts when it is paid.
    db.reset();
    free = await db.Plan.create({ key: 'free', name: 'Free', monthlyPriceAmount: 0, yearlyPriceAmount: 0 });
    pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000 });
    await store({ planId: free.id });
    expect((await switches.preview(WID, { planId: pro.id })).preview).toMatchObject({ kind: 'move', currentPeriod: null, nextRenewal: { at: null, amount: 60000, billingCycle: 'monthly' } });
  });

  it('a timing the switch does not offer is SWITCH_TIMING_NOT_AVAILABLE', async () => {
    await store({ planId: pro.id });
    await expect(switches.preview(WID, { planId: basic.id, timing: 'now' })).rejects.toMatchObject({
      code: 'SWITCH_TIMING_NOT_AVAILABLE',
      statusCode: 409,
      details: { timing: 'now', available: ['period_end'] },
    });
    await expect(switches.start(WID, { planId: basic.id, timing: 'now' }, req)).rejects.toMatchObject({ code: 'SWITCH_TIMING_NOT_AVAILABLE' });
    expect(await openOf()).toHaveLength(0);
  });

  it('the preview says how long the charge would live; a downgrade writes none', async () => {
    await store();
    const before = Date.now();
    const { preview } = await switches.preview(WID, { planId: pro.id });
    expect(preview.chargeExpiry.hours).toBe(env.billing.planSwitch.chargeExpiryHours);
    const lives = preview.chargeExpiry.expiresAt.getTime() - before;
    expect(lives).toBeGreaterThanOrEqual(48 * 3600 * 1000);
    expect(lives).toBeLessThan(48 * 3600 * 1000 + 60 * 1000);
    expect((await switches.preview(WID, { planId: free.id })).preview).toMatchObject({ kind: 'scheduled', chargeExpiry: null });
  });

  it('now: one charge at the full price for a full period from its payment; the store keeps its plan until it is paid', async () => {
    const sub = await store();
    const before = Date.now();
    const first = await switches.start(WID, { planId: pro.id, timing: 'now', expectedAmount: 60000 }, req);
    expect(first).toMatchObject({ kind: 'upgrade', created: true, switch: { kind: 'upgrade', status: 'pending', amountDue: 60000, timing: 'now', reason: 'upgrade', proration: null } });
    const [charge] = await pendingOf();
    expect(charge).toMatchObject({ amount: 60000, grossAmount: 60000, discountAmount: 0, referralCodeId: null, targetPlanId: pro.id, targetBillingCycle: 'monthly' });
    expect(charge.periodStart.getTime()).toBeGreaterThanOrEqual(before);
    expect(charge.periodEnd.getTime()).toBeGreaterThan(sub.currentPeriodEnd.getTime());
    const [row] = await openOf();
    expect(row.quote).toMatchObject({ amount: 60000, pricing: 'full_period', timing: 'now', reason: 'upgrade' });
    expect(sub.planId).toBe(basic.id);
    expect(first.switch.expiresAt).toEqual(new Date(new Date(first.switch.createdAt).getTime() + 48 * 3600 * 1000));

    const again = await switches.start(WID, { planId: pro.id }, req);
    expect(again).toMatchObject({ created: false, invoice: { id: charge.id } });
    expect(await pendingOf()).toHaveLength(1);
  });

  it('period_end: no charge now; it waits for the end of the paid period like a downgrade', async () => {
    const sub = await store();
    const result = await switches.start(WID, { planId: pro.id, timing: 'period_end', expectedAmount: 0 }, req);
    expect(result).toMatchObject({
      kind: 'scheduled',
      created: true,
      invoice: null,
      switch: { kind: 'scheduled', status: 'scheduled', effectiveAt: sub.currentPeriodEnd, reason: 'upgrade', timing: 'period_end' },
    });
    expect(await db.BillingInvoice.count()).toBe(0);
    expect(sub.planId).toBe(basic.id);
    // The same again is handed back; choosing "now" replaces it with a charge.
    expect((await switches.start(WID, { planId: pro.id, timing: 'period_end' }, req)).created).toBe(false);
    await switches.start(WID, { planId: pro.id, timing: 'now' }, req);
    expect(await db.PlanSwitch.findAll({ where: { workspaceId: WID, status: 'replaced' } })).toHaveLength(1);
    const open = await openOf();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'upgrade', status: 'pending' });
    expect(await pendingOf()).toHaveLength(1);
  });

  it('refuses an amount other than the one shown', async () => {
    await store();
    await expect(switches.start(WID, { planId: pro.id, expectedAmount: 20000 }, req)).rejects.toMatchObject({
      code: 'SWITCH_AMOUNT_CHANGED',
      details: { amountDue: 60000, currency: 'EGP' },
    });
    expect(await db.BillingInvoice.count()).toBe(0);
  });

  it('replaces a renewal charge nobody is paying, priced for the plan being left', async () => {
    const sub = await store();
    const renewal = await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, currency: 'EGP', periodStart: sub.currentPeriodEnd, periodEnd: new Date(Date.now() + 50 * DAY),
    });
    const checkout = await db.BillingPaymentAttempt.create({ billingInvoiceId: renewal.id, status: 'open' });
    expect((await switches.preview(WID, { planId: pro.id })).preview.replaces).toMatchObject({ kind: 'renewal', invoiceId: renewal.id });
    await switches.start(WID, { planId: pro.id }, req);
    expect(renewal).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect(checkout.status).toBe('superseded');
    expect(await pendingOf()).toHaveLength(1);
  });

  it('waits while a transfer for the charge is with the console; cancelling does too', async () => {
    await store();
    await switches.start(WID, { planId: pro.id }, req);
    const [charge] = await pendingOf();
    await db.PaymentProof.create({ billingInvoiceId: charge.id, status: 'pending' });
    expect((await switches.preview(WID, { planId: basic.id, billingCycle: 'yearly' })).preview.blockedBy).toBe('PROOF_UNDER_REVIEW');
    await expect(switches.start(WID, { planId: free.id }, req)).rejects.toMatchObject({ code: 'PROOF_UNDER_REVIEW', details: { invoiceId: charge.id } });
    await expect(switches.cancel(WID, req)).rejects.toMatchObject({ code: 'PROOF_UNDER_REVIEW' });
    expect(charge.status).toBe('pending');
  });

  it('the switch waiting says when a transfer for its charge is under review, and stops saying so once reviewed', async () => {
    const sub = await store();
    await switches.start(WID, { planId: pro.id }, req);
    expect((await switches.summaryFor(sub)).open).toMatchObject({ status: 'pending', proofUnderReview: false });
    const [charge] = await pendingOf();
    const proof = await db.PaymentProof.create({ billingInvoiceId: charge.id, status: 'pending' });
    expect((await switches.summaryFor(sub)).open).toMatchObject({ proofUnderReview: true, amountDue: 60000 });
    await proof.update({ status: 'rejected' });
    expect((await switches.summaryFor(sub)).open.proofUnderReview).toBe(false);
    // A scheduled switch has no charge: never.
    db.reset();
    basic = await db.Plan.create({ key: 'basic', name: 'Basic', monthlyPriceAmount: 30000, yearlyPriceAmount: 300000 });
    pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000 });
    const down = await store({ planId: pro.id });
    await switches.start(WID, { planId: basic.id }, req);
    expect((await switches.summaryFor(down)).open).toMatchObject({ status: 'scheduled', proofUnderReview: false });
  });

  it('two at once: a charge that appeared after the first lock is PLAN_SWITCH_BUSY', async () => {
    await store();
    await switches.start(WID, { planId: pro.id }, req);
    merchantPlans.lockPendingCharge.mockResolvedValueOnce(null);
    await expect(switches.start(WID, { planId: free.id }, req)).rejects.toMatchObject({ code: 'PLAN_SWITCH_BUSY' });
    expect(await openOf()).toHaveLength(1);
  });

  it('in dollars: priced, but refused when no way to pay dollars is offered', async () => {
    await store({ planId: dollar.id });
    const { preview } = await switches.preview(WID, { planId: dollarPro.id });
    expect(preview).toMatchObject({ kind: 'upgrade', currency: 'USD', payable: false, blockedBy: 'NO_PAYMENT_METHOD' });
    await expect(switches.start(WID, { planId: dollarPro.id }, req)).rejects.toMatchObject({ code: 'NO_PAYMENT_METHOD', details: { currency: 'USD' } });
  });
});

describe('a downgrade', () => {
  it('waits for the end of the paid period, nothing paid and nothing given back', async () => {
    const sub = await store({ planId: pro.id });
    const result = await switches.start(WID, { planId: basic.id }, req);
    expect(result).toMatchObject({ kind: 'scheduled', created: true, invoice: null, switch: { status: 'scheduled', effectiveAt: sub.currentPeriodEnd } });
    expect(sub.planId).toBe(pro.id);
    expect(await db.BillingInvoice.count()).toBe(0);
  });

  it('replaces an upgrade waiting for payment; an upgrade then replaces the downgrade', async () => {
    const sub = await store();
    await switches.start(WID, { planId: pro.id }, req);
    const [upgradeCharge] = await pendingOf();
    await switches.start(WID, { planId: free.id }, req);
    expect(upgradeCharge).toMatchObject({ status: 'void', voidReason: 'replaced' });
    const [downgrade] = await openOf();
    expect(downgrade).toMatchObject({ kind: 'scheduled', toPlanId: free.id });

    await switches.start(WID, { planId: pro.id }, req);
    expect(downgrade.status).toBe('replaced');
    const open = await openOf();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'upgrade', status: 'pending' });
    expect(sub.planId).toBe(basic.id);
  });

  it('choosing the plan and cycle the store is on cancels what waits', async () => {
    await store({ planId: pro.id });
    await switches.start(WID, { planId: basic.id }, req);
    const result = await switches.start(WID, { planId: pro.id, billingCycle: 'monthly' }, req);
    expect(result).toMatchObject({ kind: 'none', created: false, changed: true, switch: { status: 'cancelled' } });
    expect(await openOf()).toHaveLength(0);
  });

  it('once the next period is paid at its price it stays; a renewal waiting on it goes with a cancel', async () => {
    const sub = await store({ planId: pro.id });
    const scheduled = await switches.start(WID, { planId: basic.id }, req);
    // A renewal for the period after it, priced on it, waiting (an online checkout left open).
    const renewal = await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, currency: 'EGP', periodStart: sub.currentPeriodEnd, periodEnd: new Date(sub.currentPeriodEnd.getTime() + 30 * DAY),
    });
    expect(await switches.cancel(WID, req)).toMatchObject({ cancelled: true });
    expect(renewal).toMatchObject({ status: 'void', voidReason: 'replaced' });

    await switches.start(WID, { planId: basic.id }, req);
    await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, amountPaid: 30000, currency: 'EGP', status: 'paid', periodStart: sub.currentPeriodEnd, periodEnd: new Date(sub.currentPeriodEnd.getTime() + 30 * DAY),
    });
    await expect(switches.cancel(WID, req)).rejects.toMatchObject({ code: 'PLAN_SWITCH_ALREADY_BILLED' });
    await expect(switches.start(WID, { planId: free.id }, req)).rejects.toMatchObject({ code: 'PLAN_SWITCH_ALREADY_BILLED' });
    expect((await switches.preview(WID, { planId: pro.id, billingCycle: 'monthly' })).preview.blockedBy).toBe('PLAN_SWITCH_ALREADY_BILLED');
    // Asking for the same downgrade again is fine: it is what waits.
    expect((await switches.start(WID, { planId: basic.id }, req)).created).toBe(false);
    expect(scheduled.switch.status).toBe('scheduled');
    expect((await openOf())[0]).toMatchObject({ kind: 'scheduled', toPlanId: basic.id });
  });

  it('a cycle change alone, or another currency, also waits for the period end', async () => {
    await store();
    expect((await switches.start(WID, { planId: basic.id, billingCycle: 'yearly' }, req)).switch).toMatchObject({ kind: 'scheduled', to: { billingCycle: 'yearly' } });
    expect((await switches.start(WID, { planId: dollarPro.id }, req)).switch).toMatchObject({ kind: 'scheduled', to: { planId: dollarPro.id } });
  });
});

describe('a period that has ended', () => {
  it('changes plan at once, with nothing to pay; a stale renewal charge gives way', async () => {
    const sub = await store({ ended: true });
    const renewal = await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, currency: 'EGP', periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * DAY),
    });
    const result = await switches.start(WID, { planId: pro.id }, req);
    expect(result).toMatchObject({ kind: 'immediate', created: true, changed: true, invoice: null, switch: { status: 'applied' } });
    expect(sub.planId).toBe(pro.id);
    expect(renewal.status).toBe('void');
    expect(await pendingOf()).toHaveLength(0);
  });

  it('to a free plan: active, open-ended', async () => {
    const sub = await store({ ended: true, extra: { status: 'past_due' } });
    await switches.start(WID, { planId: free.id }, req);
    expect(sub).toMatchObject({ planId: free.id, status: 'active', trialEndsAt: null });
    expect(new Date(sub.currentPeriodEnd).getUTCFullYear()).toBeGreaterThan(new Date().getUTCFullYear() + 50);
  });
});

describe('cancelling', () => {
  it('voids the upgrade charge, leaves the store as it is, and there is then nothing to cancel', async () => {
    const sub = await store();
    await switches.start(WID, { planId: pro.id }, req);
    const [charge] = await pendingOf();
    const result = await switches.cancel(WID, req);
    expect(result).toMatchObject({ cancelled: true, switch: { status: 'cancelled' } });
    expect(charge).toMatchObject({ status: 'void', voidReason: 'cancelled' });
    expect(sub).toMatchObject({ planId: basic.id, status: 'active' });
    expect(await switches.cancel(WID, req)).toMatchObject({ cancelled: false });
    expect(merchantPlans.cancelPlanMove).toHaveBeenCalledTimes(1);
  });
});

describe('a move to pay per order', () => {
  let fee;

  beforeEach(async () => {
    env.wallet.enabled = true;
    fee = await db.Plan.create({ key: 'ppo', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, perOrderFeeAmount: 400 });
  });

  afterEach(() => {
    env.wallet.enabled = false;
  });

  it('previews like a downgrade: at the end of the paid period, nothing due and nothing to pay', async () => {
    const sub = await store();
    const { preview } = await switches.preview(WID, { planId: fee.id, billingCycle: 'yearly' });
    expect(preview).toMatchObject({
      kind: 'scheduled',
      reason: 'to_pay_per_order',
      timing: 'period_end',
      timings: ['period_end'],
      effective: 'period_end',
      effectiveAt: sub.currentPeriodEnd,
      to: { planId: fee.id, billingCycle: 'monthly' },
      currentPeriod: { endsAt: sub.currentPeriodEnd, remainingDays: 20 },
      amountDue: 0,
      payable: false,
      chargeExpiry: null,
      nextRenewal: null,
      blockedBy: null,
    });
    await expect(switches.preview(WID, { planId: fee.id, timing: 'now' })).rejects.toMatchObject({ code: 'SWITCH_TIMING_NOT_AVAILABLE' });
  });

  it('starts with nothing charged; the store keeps its plan until then; a renewal waiting gives way', async () => {
    const sub = await store();
    const renewal = await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, currency: 'EGP', periodStart: sub.currentPeriodEnd, periodEnd: new Date(sub.currentPeriodEnd.getTime() + 30 * DAY),
    });
    const result = await switches.start(WID, { planId: fee.id, expectedAmount: 0 }, req);
    expect(result).toMatchObject({
      kind: 'scheduled',
      created: true,
      invoice: null,
      switch: { kind: 'scheduled', status: 'scheduled', reason: 'to_pay_per_order', effectiveAt: sub.currentPeriodEnd, to: { planId: fee.id } },
    });
    expect(sub).toMatchObject({ planId: basic.id, status: 'active' });
    expect(renewal).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect(await pendingOf()).toHaveLength(0);
  });

  it('is cancelled before it applies, and the store stays as it is', async () => {
    const sub = await store();
    await switches.start(WID, { planId: fee.id }, req);
    expect(await switches.cancel(WID, req)).toMatchObject({ cancelled: true, switch: { status: 'cancelled', reason: 'to_pay_per_order' } });
    expect(await openOf()).toHaveLength(0);
    expect(sub.planId).toBe(basic.id);
  });

  it('applies at its moment (the hourly job): active on the plan, no period to pay', async () => {
    const sub = await store();
    await switches.start(WID, { planId: fee.id }, req);
    const [sw] = await openOf();
    expect(await switches.applyDue({ now: new Date(sub.currentPeriodEnd.getTime() - 1000) })).toEqual({ applied: 0, dropped: 0 });
    const at = new Date(sub.currentPeriodEnd.getTime() + 1000);
    expect(await switches.applyDue({ now: at })).toEqual({ applied: 1, dropped: 0 });
    expect(sw.status).toBe('applied');
    expect(sub).toMatchObject({ planId: fee.id, status: 'active', trialEndsAt: null, billingCycle: 'monthly' });
    expect(new Date(sub.currentPeriodEnd).getUTCFullYear()).toBeGreaterThan(at.getUTCFullYear() + 50);
    expect(await db.BillingInvoice.count()).toBe(0);
  });

  it('is dropped at its moment when the prepaid balance has been turned off', async () => {
    const sub = await store();
    await switches.start(WID, { planId: fee.id }, req);
    const [sw] = await openOf();
    env.wallet.enabled = false;
    expect(await switches.applyDue({ now: new Date(sub.currentPeriodEnd.getTime() + 1000) })).toEqual({ applied: 0, dropped: 1 });
    expect(sw).toMatchObject({ status: 'dropped', endReason: 'wallet_disabled' });
    expect(sub.planId).toBe(basic.id);
  });

  it('from a free plan, or once the period has ended: at once', async () => {
    const sub = await store({ ended: true });
    const result = await switches.start(WID, { planId: fee.id }, req);
    expect(result).toMatchObject({ kind: 'immediate', changed: true, switch: { status: 'applied', reason: 'to_pay_per_order' } });
    expect(sub).toMatchObject({ planId: fee.id, status: 'active' });
  });

  it('not on offer while the prepaid balance is off; a trial chooses it on its own card', async () => {
    await store();
    env.wallet.enabled = false;
    await expect(switches.preview(WID, { planId: fee.id })).rejects.toMatchObject({ code: 'PLAN_NOT_AVAILABLE', statusCode: 422 });
    await expect(switches.start(WID, { planId: fee.id }, req)).rejects.toMatchObject({ code: 'PLAN_NOT_AVAILABLE' });
    env.wallet.enabled = true;
    db.reset();
    fee = await db.Plan.create({ key: 'ppo', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, perOrderFeeAmount: 400 });
    basic = await db.Plan.create({ key: 'basic', name: 'Basic', monthlyPriceAmount: 30000, yearlyPriceAmount: 300000 });
    await store({ extra: { status: 'trialing' } });
    await expect(switches.preview(WID, { planId: fee.id })).rejects.toMatchObject({ code: 'PLAN_NOT_AVAILABLE' });
    await expect(switches.start(WID, { planId: fee.id }, req)).rejects.toMatchObject({ code: 'PLAN_NOT_AVAILABLE' });
    expect(merchantPlans.changePlan).not.toHaveBeenCalled();
  });
});

describe('cancelling a charge (the merchant) and voiding one (the console)', () => {
  const OTHER = 'workspace-2';

  async function renewalOf(sub, extra = {}) {
    return db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, currency: 'EGP', periodStart: sub.currentPeriodEnd, periodEnd: new Date(sub.currentPeriodEnd.getTime() + 30 * DAY), ...extra,
    });
  }

  it('the merchant cancels a pending renewal: void, its checkout superseded, a special-terms charge given back, the store as it was', async () => {
    const sub = await store();
    const term = await db.SubscriptionTerm.create({ chargesUsed: 1 });
    const renewal = await renewalOf(sub, { specialTermsId: term.id });
    const checkout = await db.BillingPaymentAttempt.create({ billingInvoiceId: renewal.id, status: 'open' });
    const result = await switches.cancelCharge(WID, renewal.id, req);
    expect(result).toMatchObject({ invoice: { id: renewal.id, status: 'void', cancellable: false }, plans: { listed: true } });
    expect(renewal).toMatchObject({ status: 'void', voidReason: 'cancelled_by_merchant', voidNote: null });
    expect(checkout.status).toBe('superseded');
    expect(term.chargesUsed).toBe(0);
    expect(sub).toMatchObject({ planId: basic.id, status: 'active' });
  });

  it("an upgrade's charge cancelled: its switch is cancelled too", async () => {
    const sub = await store();
    await switches.start(WID, { planId: pro.id }, req);
    const [charge] = await pendingOf();
    const [sw] = await openOf();
    await switches.cancelCharge(WID, charge.id, req);
    expect(charge.voidReason).toBe('cancelled_by_merchant');
    expect(sw).toMatchObject({ status: 'cancelled', endReason: 'charge_cancelled' });
    expect(sub.planId).toBe(basic.id);
  });

  it('refused while a transfer for it is being checked, when paid or already void, and for another store', async () => {
    const sub = await store();
    const renewal = await renewalOf(sub);
    const proof = await db.PaymentProof.create({ billingInvoiceId: renewal.id, status: 'pending' });
    await expect(switches.cancelCharge(WID, renewal.id, req)).rejects.toMatchObject({ code: 'PROOF_UNDER_REVIEW', statusCode: 409, details: { invoiceId: renewal.id } });
    expect(renewal.status).toBe('pending');
    await proof.update({ status: 'rejected' });
    await expect(switches.cancelCharge(OTHER, renewal.id, req)).rejects.toMatchObject({ statusCode: 404 });
    await switches.cancelCharge(WID, renewal.id, req);
    await expect(switches.cancelCharge(WID, renewal.id, req)).rejects.toMatchObject({ code: 'CHARGE_NOT_PENDING', statusCode: 409 });
    const paid = await renewalOf(sub, { status: 'paid', amountPaid: 30000 });
    await expect(switches.cancelCharge(WID, paid.id, req)).rejects.toMatchObject({ code: 'CHARGE_ALREADY_PAID', statusCode: 409 });
    expect(paid.status).toBe('paid');
  });

  it('the flag off: 404, nothing voided', async () => {
    const renewal = await renewalOf(await store());
    env.billing.planSwitch.enabled = false;
    await expect(switches.cancelCharge(WID, renewal.id, req)).rejects.toMatchObject({ code: 'PLAN_SWITCH_DISABLED', statusCode: 404 });
    await expect(switches.adminVoidCharge(renewal.id, { reason: 'test' }, req)).rejects.toMatchObject({ code: 'PLAN_SWITCH_DISABLED' });
    expect(renewal.status).toBe('pending');
  });

  it('the console voids any pending charge with its reason; a switch waiting for it is dropped', async () => {
    const sub = await store();
    await switches.start(WID, { planId: pro.id }, req);
    const [charge] = await pendingOf();
    const [sw] = await openOf();
    await switches.adminVoidCharge(charge.id, { reason: 'Asked by phone to drop it' }, { user: { id: 'admin-1' } });
    expect(charge).toMatchObject({ status: 'void', voidReason: 'voided_by_admin', voidNote: 'Asked by phone to drop it' });
    expect(sw).toMatchObject({ status: 'dropped', endReason: 'admin_void' });
    expect(sub.planId).toBe(basic.id);
  });

  it('the console is refused while a transfer for the charge waits for review, and for a paid one', async () => {
    const sub = await store();
    const renewal = await renewalOf(sub);
    await db.PaymentProof.create({ billingInvoiceId: renewal.id, status: 'pending' });
    await expect(switches.adminVoidCharge(renewal.id, { reason: 'x' }, req)).rejects.toMatchObject({ code: 'PROOF_UNDER_REVIEW' });
    const paid = await renewalOf(sub, { status: 'paid', amountPaid: 30000 });
    await expect(switches.adminVoidCharge(paid.id, { reason: 'x' }, req)).rejects.toMatchObject({ code: 'CHARGE_ALREADY_PAID' });
  });
});

describe('a payment for an upgrade that did not go through', () => {
  it('voids the charge and cancels the switch: the store stays on its plan with nothing pending', async () => {
    const sub = await store();
    await switches.start(WID, { planId: pro.id }, req);
    const [charge] = await pendingOf();
    const [sw] = await openOf();
    await db.BillingPaymentAttempt.create({ billingInvoiceId: charge.id, status: 'failed' });
    expect(await switches.paymentFailed(charge.id, { source: 'webhook:failed' })).toBe(true);
    expect(charge).toMatchObject({ status: 'void', voidReason: 'payment_failed' });
    expect(sw).toMatchObject({ status: 'cancelled', endReason: 'payment_failed' });
    expect(sub).toMatchObject({ planId: basic.id, status: 'active' });
    expect(await pendingOf()).toHaveLength(0);
    expect(await openOf()).toHaveLength(0);
    // The upgrade can be started again.
    expect((await switches.start(WID, { planId: pro.id }, req)).created).toBe(true);
  });

  it('left alone while another checkout or a transfer may still pay it', async () => {
    await store();
    await switches.start(WID, { planId: pro.id }, req);
    const [charge] = await pendingOf();
    const other = await db.BillingPaymentAttempt.create({ billingInvoiceId: charge.id, status: 'open' });
    expect(await switches.paymentFailed(charge.id)).toBe(false);
    await other.update({ status: 'expired' });
    const proof = await db.PaymentProof.create({ billingInvoiceId: charge.id, status: 'pending' });
    expect(await switches.paymentFailed(charge.id)).toBe(false);
    expect(charge.status).toBe('pending');
    await proof.update({ status: 'rejected' });
    expect(await switches.paymentFailed(charge.id, { source: 'proof_rejected' })).toBe(true);
    expect(charge.voidReason).toBe('payment_failed');
  });

  it('a renewal is left as before, and so is everything with the flag off', async () => {
    const sub = await store();
    const renewal = await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, currency: 'EGP', periodStart: sub.currentPeriodEnd, periodEnd: new Date(sub.currentPeriodEnd.getTime() + 30 * DAY),
    });
    expect(await switches.paymentFailed(renewal.id)).toBe(false);
    expect(renewal.status).toBe('pending');
    await renewal.update({ status: 'void', voidReason: 'replaced' });
    await switches.start(WID, { planId: pro.id }, req);
    const [charge] = await pendingOf();
    env.billing.planSwitch.enabled = false;
    expect(await switches.paymentFailed(charge.id)).toBe(false);
    expect(charge.status).toBe('pending');
  });
});

describe('what is not changed here', () => {
  it('a trial changes plan as before, and pay per order moves as before', async () => {
    await store({ extra: { status: 'trialing' } });
    expect(await switches.start(WID, { planId: pro.id }, req)).toMatchObject({ kind: 'trial_change', changed: true });
    expect(merchantPlans.changePlan).toHaveBeenCalledTimes(1);
    expect(merchantPlans.changePlan.mock.calls[0][3]).toEqual({ replacePending: true });
    db.reset();
    const fee = await db.Plan.create({ key: 'ppo', name: 'Pay per order', monthlyPriceAmount: 0, yearlyPriceAmount: 0, perOrderFeeAmount: 400 });
    pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000 });
    await store({ planId: fee.id });
    expect(await switches.start(WID, { planId: pro.id }, req)).toMatchObject({ kind: 'move', created: true });
    expect(merchantPlans.requestPlanMove).toHaveBeenCalledWith(WID, { planId: pro.id, billingCycle: 'monthly' }, req, { replacePending: true });
  });

  it('refuses what support decides', async () => {
    await store({ extra: { pricingKind: 'free' } });
    await expect(switches.start(WID, { planId: pro.id }, req)).rejects.toMatchObject({ code: 'MANUAL_PRICING', statusCode: 409 });
    db.reset();
    basic = await db.Plan.create({ key: 'basic', name: 'Basic', monthlyPriceAmount: 30000, yearlyPriceAmount: 300000 });
    pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000 });
    await store();
    specialTerms.activePriceOverride.mockResolvedValue({ id: 'term' });
    await expect(switches.preview(WID, { planId: pro.id })).rejects.toMatchObject({ code: 'SPECIAL_TERMS_ACTIVE' });
    specialTerms.activePriceOverride.mockResolvedValue(null);
    await expect(switches.start(WID, { planId: 'f0f0f0f0-0000-4000-8000-000000000000' }, req)).rejects.toMatchObject({ code: 'PLAN_NOT_AVAILABLE' });
  });

  it('the plans list says how the store changes plan, and shows the switch waiting', async () => {
    const sub = await store();
    expect(await switches.summaryFor(sub)).toEqual({ enabled: true, mode: 'switch', reason: null, open: null });
    await switches.start(WID, { planId: pro.id }, req);
    const summary = await switches.summaryFor(sub);
    expect(summary.open).toMatchObject({ kind: 'upgrade', from: { planName: 'Basic' }, to: { planName: 'Pro' }, amountDue: 60000 });
    env.billing.planSwitch.enabled = false;
    expect(await switches.summaryFor(sub)).toMatchObject({ enabled: false, mode: null, open: { kind: 'upgrade' } });
  });
});
