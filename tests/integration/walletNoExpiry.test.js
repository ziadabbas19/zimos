'use strict';

// The prepaid balance never expires or decays: no scheduled job touches the
// wallet, and the billing sweeps run two years later leave the balance, its
// cache and its ledger exactly as they were. docs/billing-wallet.md says so.

const fs = require('fs');
const path = require('path');
const { setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');
const wallet = require('../../src/modules/billing/walletService');
const ledgerCheck = require('../../scripts/check-wallet-ledger');

const ROOT = path.join(__dirname, '../..');
const TWO_YEARS_MS = 2 * 366 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  env.wallet.enabled = true;
});

afterEach(() => {
  jest.useRealTimers();
  env.wallet.enabled = false;
});

/** Every scheduled job's file: core's own and each module's jobs.js. */
function jobFiles() {
  const modules = path.join(ROOT, 'src/modules');
  return [
    path.join(ROOT, 'src/core/queue/coreJobs.js'),
    ...fs
      .readdirSync(modules)
      .map((name) => path.join(modules, name, 'jobs.js'))
      .filter((file) => fs.existsSync(file)),
  ];
}

async function snapshot(wid) {
  const row = await db.WorkspaceWallet.findOne({ where: { workspaceId: wid } });
  const entries = await db.WalletLedgerEntry.findAll({ where: { workspaceId: wid }, order: [['createdAt', 'ASC']], raw: true });
  return { balance: Number(row.cashBalance), toppedUp: Number(row.totalToppedUp), entries };
}

describe('the prepaid balance never expires', () => {
  it('no scheduled job is about the wallet, but for the billing ones that never move its money', () => {
    const files = jobFiles();
    expect(files.length).toBeGreaterThan(5);
    // Known and checked: voiding unpaid move charges, and the fallback to pay
    // per order (a plan change). Neither writes a ledger entry.
    const allowed = { 'billing/jobs.js': ['billing.expire_plan_moves', 'billing.wallet_fallback'] };
    for (const file of files) {
      const rel = path.relative(path.join(ROOT, 'src/modules'), file).split(path.sep).join('/');
      const mentions = /wallet/i.test(fs.readFileSync(file, 'utf8'));
      if (!allowed[rel]) {
        expect([file, mentions]).toEqual([file, false]);
        continue;
      }
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const names = require(file).schedules.map((schedule) => schedule.name);
      // Neither looks at the wallet: manual pricing, and plan switches
      // (voiding unpaid switch charges, applying scheduled downgrades).
      const walletOnes = names.filter((name) => !['billing.manual_pricing_sweep', 'billing.plan_switches'].includes(name));
      expect(walletOnes.every((name) => allowed[rel].includes(name))).toBe(true);
    }
  });

  it('two years on, the billing sweeps leave the balance and its ledger as they were', async () => {
    const setup = await setupWorkspaceWithProduct({ stock: 1 });
    const wid = setup.workspace.id;
    const proof = { id: require('crypto').randomUUID(), workspaceId: wid, methodCode: 'instapay' };
    await db.sequelize.transaction((t) => wallet.creditTopup(proof, 100000, null, t));
    const before = await snapshot(wid);

    // Only the clock moves: timers stay real so the database driver works.
    jest.useFakeTimers({
      now: Date.now() + TWO_YEARS_MS,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'],
    });
    expect(new Date().getUTCFullYear()).toBeGreaterThanOrEqual(new Date(before.entries[0].createdAt).getUTCFullYear() + 2);

    // The sweeps that look at time and money: every billing schedule, the
    // console's subscription sweep, and the online-payment sweep.
    for (const file of [path.join(ROOT, 'src/modules/billing/jobs.js'), path.join(ROOT, 'src/modules/platformAdmin/jobs.js')]) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      for (const schedule of require(file).schedules || []) await schedule.handle();
    }
    await require('../../src/modules/billing/onlineBillingService').sweep({ at: new Date() });
    const summary = await wallet.summary(wid);

    expect(await snapshot(wid)).toEqual(before);
    expect(summary.balance).toBe(100000);
    for (const row of await ledgerCheck.check()) expect(ledgerCheck.problemsOf(row)).toEqual([]);
  });
});
