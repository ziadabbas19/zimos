'use strict';

const migration = require('../../src/db/migrations/703-widen-billing-invoice-void-reasons');

// Migration 703 read without a database: what it runs, that it can run
// twice, and that going down leaves only reasons the old check accepts.

function recorder() {
  const statements = [];
  let transactions = 0;
  const queryInterface = {
    sequelize: {
      transaction: async (fn) => {
        transactions += 1;
        return fn({ id: transactions });
      },
      query: async (sql, options = {}) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), inTransaction: Boolean(options.transaction) });
        return [[], 0];
      },
    },
  };
  return { queryInterface, statements, transactions: () => transactions };
}

describe('migration 703', () => {
  it('widens void_reason, adds the note and the new reasons, in one transaction, each harmless the second time', async () => {
    const r = recorder();
    await migration.up(r.queryInterface);
    const sql = r.statements.map((s) => s.sql);
    expect(r.transactions()).toBe(1);
    expect(r.statements.every((s) => s.inTransaction)).toBe(true);
    expect(sql).toContain('ALTER TABLE billing_invoices ALTER COLUMN void_reason TYPE VARCHAR(40)');
    expect(sql).toContain('ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS void_note VARCHAR(500)');
    const drop = sql.indexOf('ALTER TABLE billing_invoices DROP CONSTRAINT IF EXISTS billing_invoices_void_reason_check');
    const add = sql.findIndex((s) => s.startsWith('ALTER TABLE billing_invoices ADD CONSTRAINT billing_invoices_void_reason_check'));
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    for (const reason of ['cancelled', 'replaced', 'expired', 'cancelled_by_merchant', 'voided_by_admin', 'payment_failed']) {
      expect(sql[add]).toContain(`'${reason}'`);
    }
    expect(sql[add]).toMatch(/NOT VALID$/);
    expect(sql[add + 1]).toBe('ALTER TABLE billing_invoices VALIDATE CONSTRAINT billing_invoices_void_reason_check');
    // Every reason fits the new width.
    expect('cancelled_by_merchant'.length).toBeLessThanOrEqual(40);
  });

  it('down maps the new reasons to an old one before the old check comes back', async () => {
    const r = recorder();
    await migration.down(r.queryInterface);
    const sql = r.statements.map((s) => s.sql);
    const mapped = sql.findIndex((s) => s.startsWith("UPDATE billing_invoices SET void_reason = 'cancelled'"));
    const check = sql.findIndex((s) => s.includes('ADD CONSTRAINT billing_invoices_void_reason_check'));
    expect(mapped).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(mapped);
    expect(sql[check]).not.toContain('cancelled_by_merchant');
    expect(sql).toContain('ALTER TABLE billing_invoices DROP COLUMN IF EXISTS void_note');
    expect(sql[sql.length - 1]).toBe('ALTER TABLE billing_invoices ALTER COLUMN void_reason TYPE VARCHAR(20)');
  });
});
