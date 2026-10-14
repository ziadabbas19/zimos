'use strict';

// What money paid for a plan switch's charge does (billing/planSwitchSettlement
// through subscriptionChargeService), with an in-memory stand-in for the
// models: no database. The same paths with a real database are in
// tests/integration/planSwitch.test.js.

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
jest.mock('../../src/modules/billing/walletService', () => ({
  WALLET_CURRENCY: 'EGP',
  lockWallet: jest.fn(async (workspaceId) => ({ workspaceId, cashBalance: 0, currency: 'EGP' })),
  writeEntry: jest.fn(async (wallet, entry) => ({ id: 'ledger-entry', ...entry })),
}));
jest.mock('../../src/core/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../../src/db/models');
const wallet = require('../../src/modules/billing/walletService');
const { recordAudit } = require('../../src/modules/audit/auditService');
const charges = require('../../src/modules/billing/subscriptionChargeService');

const DAY = 24 * 60 * 60 * 1000;
const WID = 'workspace-1';
const t = db.transaction;

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

async function paidStore({ planId, start = new Date(Date.now() - 10 * DAY), end = new Date(Date.now() + 20 * DAY), extra = {} } = {}) {
  return db.Subscription.create({
    workspaceId: WID,
    planId: planId || basic.id,
    billingCycle: 'monthly',
    status: 'active',
    currentPeriodStart: start,
    currentPeriodEnd: end,
    ...extra,
  });
}

async function switchCharge(subscription, { kind = 'upgrade', amount = 20000, to = pro, from = basic, currency = 'EGP', status = 'pending' } = {}) {
  const invoice = await db.BillingInvoice.create({
    workspaceId: WID,
    subscriptionId: subscription.id,
    grossAmount: amount,
    amount,
    currency,
    status,
    periodStart: new Date(),
    periodEnd: subscription.currentPeriodEnd,
    targetPlanId: to.id,
    targetBillingCycle: 'monthly',
    ...(status === 'void' ? { voidReason: 'expired', voidedAt: new Date() } : {}),
  });
  const sw = await db.PlanSwitch.create({
    workspaceId: WID,
    subscriptionId: subscription.id,
    kind,
    status: status === 'void' ? 'expired' : 'pending',
    fromPlanId: from.id,
    fromBillingCycle: 'monthly',
    toPlanId: to.id,
    toBillingCycle: 'monthly',
    billingInvoiceId: invoice.id,
  });
  return { invoice, sw };
}

const pay = (invoice, extra = {}) => charges.settlePaid(invoice, { paidAt: new Date(), source: 'manual', amountPaid: Number(invoice.amount), recordedByUserId: 'admin-1', ...extra }, t);

describe('an upgrade paid on time', () => {
  it('moves the store to the new plan now and keeps the paid period', async () => {
    const sub = await paidStore();
    const end = sub.currentPeriodEnd;
    const { invoice, sw } = await switchCharge(sub);
    await pay(invoice);
    expect(sub).toMatchObject({ planId: pro.id, billingCycle: 'monthly', status: 'active', currentPeriodEnd: end });
    expect(invoice).toMatchObject({ status: 'paid', amountPaid: 20000 });
    expect(invoice.subscriptionBeforePayment).toMatchObject({ planId: basic.id, billingCycle: 'monthly', currentPeriodEnd: end });
    expect(sw).toMatchObject({ status: 'applied' });
    expect(sw.appliedAt).toBeInstanceOf(Date);
    expect(recordAudit.mock.calls.map(([a]) => a.action)).toContain('subscription.plan_switch_applied');
  });

  it('a pay-per-order move (no switch row) still starts a full period, as before', async () => {
    const sub = await paidStore({ extra: { status: 'active' } });
    const invoice = await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 60000, amount: 60000, currency: 'EGP',
      periodStart: new Date(), periodEnd: new Date(), targetPlanId: pro.id, targetBillingCycle: 'monthly',
    });
    await pay(invoice);
    expect(sub.planId).toBe(pro.id);
    expect(new Date(sub.currentPeriodStart).getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(new Date(sub.currentPeriodEnd).getTime() - new Date(sub.currentPeriodStart).getTime()).toBeGreaterThanOrEqual(28 * DAY);
  });

  it('from a free plan the new plan gets a full period from the payment', async () => {
    const sub = await paidStore({ planId: free.id, end: new Date(Date.now() + 36500 * DAY) });
    const { invoice, sw } = await switchCharge(sub, { kind: 'move', from: free, amount: 60000 });
    await pay(invoice);
    expect(sub.planId).toBe(pro.id);
    const length = new Date(sub.currentPeriodEnd).getTime() - new Date(sub.currentPeriodStart).getTime();
    expect(length).toBeGreaterThanOrEqual(28 * DAY);
    expect(length).toBeLessThanOrEqual(31 * DAY);
    expect(sw.status).toBe('applied');
  });
});

describe('money that can no longer do what it was for', () => {
  it('is not applied when the plan changed under the charge: void, switch dropped, balance credited', async () => {
    const sub = await paidStore();
    const { invoice, sw } = await switchCharge(sub);
    await sub.update({ planId: free.id }); // the console moved the store meanwhile
    const result = await pay(invoice, { externalReference: 'proof:abc' });
    expect(result.lateMove).toBe('credited');
    expect(invoice).toMatchObject({ status: 'void', voidReason: 'replaced', amountPaid: 20000 });
    expect(sw).toMatchObject({ status: 'dropped', endReason: 'plan_changed' });
    expect(sub.planId).toBe(free.id);
    expect(wallet.writeEntry).toHaveBeenCalledTimes(1);
    expect(wallet.writeEntry.mock.calls[0][1]).toMatchObject({ type: 'move_payment_credit', delta: 20000, key: 'move_payment_credit:proof:abc' });
  });

  it('a late payment of an expired upgrade applies while the store is as it was priced', async () => {
    const sub = await paidStore();
    const { invoice, sw } = await switchCharge(sub, { status: 'void' });
    const result = await pay(invoice);
    expect(result.lateMove).toBe('applied');
    expect(invoice.status).toBe('paid');
    expect(sw.status).toBe('applied');
    expect(sub.planId).toBe(pro.id);
    expect(wallet.writeEntry).not.toHaveBeenCalled();
  });

  it('a late payment is credited when the merchant has asked for something else since', async () => {
    const sub = await paidStore();
    const { invoice, sw } = await switchCharge(sub, { status: 'void' });
    await db.PlanSwitch.create({
      workspaceId: WID, subscriptionId: sub.id, kind: 'scheduled', status: 'scheduled', fromPlanId: basic.id,
      fromBillingCycle: 'monthly', toPlanId: free.id, toBillingCycle: 'monthly', effectiveAt: sub.currentPeriodEnd,
    });
    const result = await pay(invoice);
    expect(result.lateMove).toBe('credited');
    expect(invoice.status).toBe('void');
    expect(sw.status).toBe('expired');
    expect(sub.planId).toBe(basic.id);
  });

  it('a switch charge in another currency is never credited to the EGP balance', async () => {
    const sub = await paidStore();
    const { invoice } = await switchCharge(sub, { status: 'void', currency: 'USD', amount: 1500 });
    await sub.update({ planId: free.id });
    const result = await pay(invoice);
    expect(result.lateMove).toBe('unapplied');
    expect(wallet.writeEntry).not.toHaveBeenCalled();
    expect(invoice.amountPaid).toBe(1500);
    expect(invoice.paymentNote).toMatch(/refund by hand/);
  });
});

describe('voiding and failing', () => {
  it('a voided switch charge closes its switch with the same word', async () => {
    const sub = await paidStore();
    const { invoice, sw } = await switchCharge(sub);
    expect(await charges.voidMoveCharge(invoice, 'cancelled', {}, t)).toBe(true);
    expect(invoice).toMatchObject({ status: 'void', voidReason: 'cancelled' });
    expect(sw).toMatchObject({ status: 'cancelled' });
  });

  it('a renewal gives way: void as replaced, its special-terms charge given back; a switch charge is refused', async () => {
    const sub = await paidStore();
    const term = await db.SubscriptionTerm.create({ subscriptionId: sub.id, kind: 'price_override', chargesTotal: 3, chargesUsed: 1 });
    const renewal = await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 30000, amount: 30000, currency: 'EGP',
      periodStart: sub.currentPeriodEnd, periodEnd: new Date(Date.now() + 50 * DAY), specialTermsId: term.id,
    });
    const attempt = await db.BillingPaymentAttempt.create({ billingInvoiceId: renewal.id, status: 'open' });
    expect(await charges.voidRenewalCharge(renewal, {}, t)).toBe(true);
    expect(renewal).toMatchObject({ status: 'void', voidReason: 'replaced' });
    expect(attempt.status).toBe('superseded');
    expect(term.chargesUsed).toBe(0);
    const { invoice } = await switchCharge(await paidStore());
    expect(await charges.voidRenewalCharge(invoice, {}, t)).toBe(false);
  });

  it('a failed payment leaves a switch charge payable and the subscription alone', async () => {
    const sub = await paidStore();
    const { invoice, sw } = await switchCharge(sub);
    const { changed } = await charges.markChargeFailed(invoice.id, { reason: 'declined' });
    expect(changed).toBe(false);
    expect(invoice.status).toBe('pending');
    expect(sw.status).toBe('pending');
    expect(sub.status).toBe('active');
  });
});

describe('a reversed payment', () => {
  it('puts the store back and the switch waits for its charge again; one asked since is dropped', async () => {
    const sub = await paidStore();
    const { invoice, sw } = await switchCharge(sub);
    await pay(invoice);
    const later = await db.PlanSwitch.create({
      workspaceId: WID, subscriptionId: sub.id, kind: 'scheduled', status: 'scheduled', fromPlanId: pro.id,
      fromBillingCycle: 'monthly', toPlanId: basic.id, toBillingCycle: 'monthly', effectiveAt: sub.currentPeriodEnd,
    });
    const { subscriptionStatus } = await charges.reverseManualPayment(invoice.id, { reason: 'bounced' }, { user: { id: 'admin-1' } });
    expect(sub.planId).toBe(basic.id);
    expect(invoice.status).toBe('pending');
    expect(sw).toMatchObject({ status: 'pending', appliedAt: null });
    expect(later).toMatchObject({ status: 'dropped', endReason: 'payment_reversed' });
    expect(subscriptionStatus.planSwitchReopened).toBe(sw.id);
  });
});

describe('the next charge with a downgrade scheduled', () => {
  async function scheduled({ toPlan = basic, toCycle = 'monthly', fromPlan = pro } = {}) {
    const start = new Date('2026-03-01T00:00:00Z');
    const end = new Date('2026-04-01T00:00:00Z');
    const sub = await paidStore({ planId: pro.id, start, end });
    await db.BillingInvoice.create({
      workspaceId: WID, subscriptionId: sub.id, grossAmount: 60000, amount: 60000, amountPaid: 60000, currency: 'EGP', status: 'paid', periodStart: start, periodEnd: end,
    });
    await db.PlanSwitch.create({
      workspaceId: WID, subscriptionId: sub.id, kind: 'scheduled', status: 'scheduled', fromPlanId: fromPlan.id,
      fromBillingCycle: 'monthly', toPlanId: toPlan.id, toBillingCycle: toCycle, effectiveAt: end,
    });
    return sub;
  }
  const now = new Date('2026-03-17T12:00:00Z');

  it('prices the period after the paid one on the plan and cycle asked for', async () => {
    await scheduled();
    const { quote } = await charges.quoteCharge(WID, { now });
    expect(quote).toMatchObject({ grossAmount: 30000, amount: 30000, currency: 'EGP' });
    expect(quote.periodStart).toEqual(new Date('2026-04-01T00:00:00Z'));
    expect(quote.periodEnd).toEqual(new Date('2026-05-01T00:00:00Z'));
  });

  it('a cycle change prices a year', async () => {
    await scheduled({ toPlan: pro, toCycle: 'yearly' });
    const { quote } = await charges.quoteCharge(WID, { now });
    expect(quote).toMatchObject({ grossAmount: 600000 });
    expect(quote.periodEnd).toEqual(new Date('2027-04-01T00:00:00Z'));
  });

  it('a schedule that no longer fits the store prices nothing: the store plan does', async () => {
    await scheduled({ fromPlan: basic });
    const { quote } = await charges.quoteCharge(WID, { now });
    expect(quote).toMatchObject({ grossAmount: 60000 });
  });

  it('a downgrade to a free plan leaves nothing to pay for the next period', async () => {
    await scheduled({ toPlan: free });
    await expect(charges.quoteCharge(WID, { now })).rejects.toMatchObject({ code: 'PLAN_IS_FREE' });
  });
});
