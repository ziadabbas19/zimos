'use strict';

// The hourly billing job of plan switches (planSwitchService.runDue), and the
// console or a cycle change acting under a switch waiting, on an in-memory
// stand-in for the models: no database.

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
jest.mock('../../src/core/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../../src/db/models');
const env = require('../../src/config/env');
const switches = require('../../src/modules/billing/planSwitchService');
const jobs = require('../../src/modules/billing/jobs');
const billingService = require('../../src/modules/billing/billingService');
const manual = require('../../src/modules/billing/manualSubscriptionService');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WID = 'workspace-1';
const admin = { user: { id: 'admin-1' }, headers: {} };

let basic;
let pro;
let free;

beforeEach(async () => {
  db.reset();
  jest.clearAllMocks();
  basic = await db.Plan.create({ key: 'basic', name: 'Basic', monthlyPriceAmount: 30000, yearlyPriceAmount: 300000 });
  pro = await db.Plan.create({ key: 'pro', name: 'Pro', monthlyPriceAmount: 60000, yearlyPriceAmount: 600000 });
  free = await db.Plan.create({ key: 'free', name: 'Free', monthlyPriceAmount: 0, yearlyPriceAmount: 0 });
});

async function store(planId, end = new Date(Date.now() + 20 * DAY)) {
  return db.Subscription.create({
    workspaceId: WID,
    planId,
    billingCycle: 'monthly',
    status: 'active',
    currentPeriodStart: new Date(end.getTime() - 30 * DAY),
    currentPeriodEnd: end,
  });
}

async function waitingUpgrade(sub, { age = 0 } = {}) {
  const createdAt = new Date(Date.now() - age);
  const invoice = await db.BillingInvoice.create({
    workspaceId: WID, subscriptionId: sub.id, grossAmount: 20000, amount: 20000, currency: 'EGP', periodStart: createdAt, periodEnd: sub.currentPeriodEnd,
    targetPlanId: pro.id, targetBillingCycle: 'monthly', createdAt,
  });
  const sw = await db.PlanSwitch.create({
    workspaceId: WID, subscriptionId: sub.id, kind: 'upgrade', status: 'pending', fromPlanId: sub.planId, fromBillingCycle: 'monthly',
    toPlanId: pro.id, toBillingCycle: 'monthly', billingInvoiceId: invoice.id, createdAt,
  });
  return { invoice, sw };
}

async function scheduledSwitch(sub, { to = basic, cycle = 'monthly', from = sub.planId, at = sub.currentPeriodEnd } = {}) {
  return db.PlanSwitch.create({
    workspaceId: WID, subscriptionId: sub.id, kind: 'scheduled', status: 'scheduled', fromPlanId: from, fromBillingCycle: 'monthly',
    toPlanId: to.id, toBillingCycle: cycle, effectiveAt: at,
  });
}

describe('the hourly job', () => {
  it('is on the billing schedule', async () => {
    const job = jobs.schedules.find((j) => j.name === 'billing.plan_switches');
    expect(job).toMatchObject({ everyMs: HOUR });
    expect(await job.handle()).toEqual({ expired: 0, applied: 0, dropped: 0 });
  });

  it('voids an upgrade charge left unpaid past its hours, and leaves the store as it is', async () => {
    const sub = await store(basic.id);
    const stale = await waitingUpgrade(sub, { age: (env.billing.planSwitch.chargeExpiryHours + 1) * HOUR });
    expect(await switches.runDue()).toEqual({ expired: 1, applied: 0, dropped: 0 });
    expect(stale.invoice).toMatchObject({ status: 'void', voidReason: 'expired' });
    expect(stale.sw.status).toBe('expired');
    expect(sub.planId).toBe(basic.id);
  });

  it('leaves a younger one', async () => {
    const young = await waitingUpgrade(await store(basic.id), { age: HOUR });
    expect((await switches.runDue()).expired).toBe(0);
    expect(young.invoice.status).toBe('pending');
  });

  it('leaves a charge whose transfer proof is with the console', async () => {
    const { invoice, sw } = await waitingUpgrade(await store(basic.id), { age: 100 * HOUR });
    await db.PaymentProof.create({ billingInvoiceId: invoice.id, status: 'pending' });
    expect((await switches.runDue()).expired).toBe(0);
    expect(invoice.status).toBe('pending');
    expect(sw.status).toBe('pending');
  });

  it('applies a downgrade when its moment has come, not before; the period is not touched', async () => {
    const sub = await store(pro.id, new Date(Date.now() - HOUR));
    const end = sub.currentPeriodEnd;
    const sw = await scheduledSwitch(sub, { to: basic, cycle: 'yearly' });
    const later = await scheduledSwitch(await store(pro.id), { to: basic });
    expect(await switches.runDue()).toEqual({ expired: 0, applied: 1, dropped: 0 });
    expect(sub).toMatchObject({ planId: basic.id, billingCycle: 'yearly', currentPeriodEnd: end });
    expect(sw.status).toBe('applied');
    expect(later.status).toBe('scheduled');
  });

  it('a downgrade to a free plan starts it as an open-ended active period', async () => {
    const sub = await store(pro.id, new Date(Date.now() - HOUR));
    await sub.update({ status: 'past_due' });
    await scheduledSwitch(sub, { to: free });
    await switches.runDue();
    expect(sub).toMatchObject({ planId: free.id, status: 'active' });
    expect(new Date(sub.currentPeriodEnd).getUTCFullYear()).toBeGreaterThan(new Date().getUTCFullYear() + 50);
  });

  it('drops a downgrade that no longer fits the store, with why', async () => {
    const sub = await store(pro.id, new Date(Date.now() - HOUR));
    const sw = await scheduledSwitch(sub, { from: basic.id }); // the store is no longer on the plan it was asked from
    expect(await switches.runDue()).toEqual({ expired: 0, applied: 0, dropped: 1 });
    expect(sw).toMatchObject({ status: 'dropped', endReason: 'plan_changed' });
    expect(sub.planId).toBe(pro.id);
  });
});

describe('the console acting under a switch waiting', () => {
  it('changing the plan drops it and voids its charge', async () => {
    const sub = await store(basic.id);
    const { invoice, sw } = await waitingUpgrade(sub);
    await manual.changePlan(WID, { planId: free.id, note: 'moved by support' }, admin);
    expect(sw).toMatchObject({ status: 'dropped', endReason: 'admin_change_plan' });
    expect(invoice).toMatchObject({ status: 'void', voidReason: 'replaced' });
  });

  it('extending keeps a scheduled downgrade', async () => {
    const sub = await store(pro.id);
    const sw = await scheduledSwitch(sub);
    await manual.extend(WID, { duration: { days: 10 }, note: 'goodwill' }, admin);
    expect(sw.status).toBe('scheduled');
  });

  it('a cycle change: the merchant is told to cancel first, the console drops it', async () => {
    const sub = await store(pro.id);
    const sw = await scheduledSwitch(sub);
    await expect(billingService.setBillingCycle(WID, 'yearly', { user: { id: 'owner-1' } })).rejects.toMatchObject({ code: 'PLAN_SWITCH_WAITING' });
    expect(sub.billingCycle).toBe('monthly');
    await billingService.setBillingCycle(WID, 'yearly', admin, { platform: true });
    expect(sub.billingCycle).toBe('yearly');
    expect(sw).toMatchObject({ status: 'dropped', endReason: 'admin_billing_cycle' });
  });
});
