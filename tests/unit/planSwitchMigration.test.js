'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const migration = require('../../src/db/migrations/702-create-plan-switches');
const definePlanSwitch = require('../../src/db/models/PlanSwitch');
const rules = require('../../src/modules/billing/planSwitchRules');
const { TABLES } = require('../../scripts/launch-reset-tables');

// Migration 702 (plan_switches) read without a database: what it would run,
// that it can run twice, that going down never leaves a switch's charge
// payable as a pay-per-order move, and that the model reads what it creates.

function recorder({ tableExists = true } = {}) {
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
        if (/to_regclass/.test(sql)) return [[{ exists: tableExists }]];
        return [[], 0];
      },
    },
  };
  return { queryInterface, statements, transactions: () => transactions };
}

describe('migration 702', () => {
  it('creates one new table and its indexes, all in one transaction, each harmless the second time', async () => {
    const r = recorder();
    await migration.up(r.queryInterface);
    expect(r.transactions()).toBe(1);
    expect(r.statements.every((s) => s.inTransaction)).toBe(true);
    expect(r.statements.every((s) => /^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS /.test(s.sql))).toBe(true);
    // Nothing that exists today is altered.
    expect(r.statements.some((s) => /^(ALTER|DROP|UPDATE|DELETE|INSERT)\b/i.test(s.sql))).toBe(false);
    const create = r.statements[0].sql;
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS plan_switches \(/);
    for (const kind of rules.KINDS) expect(create).toContain(`'${kind}'`);
    for (const status of rules.STATUSES) expect(create).toContain(`'${status}'`);
    expect(r.statements.map((s) => s.sql)).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS plan_switches_one_open_idx ON plan_switches (subscription_id) WHERE status IN ('pending', 'scheduled')"
    );
  });

  it('down voids the charge of a switch still waiting before the table goes', async () => {
    const r = recorder();
    await migration.down(r.queryInterface);
    const sql = r.statements.map((s) => s.sql);
    const voiding = sql.findIndex((s) => s.startsWith('UPDATE billing_invoices'));
    const dropping = sql.findIndex((s) => s === 'DROP TABLE IF EXISTS plan_switches');
    expect(voiding).toBeGreaterThan(-1);
    expect(dropping).toBeGreaterThan(voiding);
    expect(sql[voiding]).toContain("SET status = 'void'");
    expect(sql[voiding]).toContain("void_reason = 'cancelled'");
    expect(sql[voiding]).toContain("WHERE status = 'pending'");
    expect(sql[voiding]).toContain("FROM plan_switches WHERE status = 'pending'");
  });

  it('down with no table only drops if exists (it can run twice)', async () => {
    const r = recorder({ tableExists: false });
    await migration.down(r.queryInterface);
    expect(r.statements.map((s) => s.sql).filter((s) => !/to_regclass/.test(s))).toEqual(['DROP TABLE IF EXISTS plan_switches']);
  });

  it('the model reads exactly the columns the table has', async () => {
    const r = recorder();
    await migration.up(r.queryInterface);
    const body = r.statements[0].sql.replace(/^CREATE TABLE IF NOT EXISTS plan_switches \(/, '');
    const columns = body
      .split(/,(?![^(]*\))/)
      .map((part) => part.trim().split(' ')[0])
      .filter((name) => /^[a-z_]+$/.test(name) && name !== 'CONSTRAINT');
    // No connection is made by defining a model.
    const sequelize = new Sequelize('postgres://nobody:nothing@127.0.0.1:1/none', { logging: false });
    const PlanSwitch = definePlanSwitch(sequelize, DataTypes);
    const fields = Object.values(PlanSwitch.rawAttributes).map((a) => a.field);
    expect(fields.sort()).toEqual(columns.sort());
    expect(PlanSwitch.OPEN).toEqual(rules.OPEN_STATUSES);
  });

  it('the launch reset knows the table', () => {
    expect(TABLES.plan_switches).toMatchObject({ action: 'wipe' });
  });
});
