'use strict';

const m714 = require('../../src/db/migrations/714-webhook-secret-sealed');
const m715 = require('../../src/db/migrations/715-option-choice-external-code');
const m716 = require('../../src/db/migrations/716-create-api-key-order-acks');
const m717 = require('../../src/db/migrations/717-create-order-pos-statuses');
const m719 = require('../../src/db/migrations/719-webhook-configurer-and-feed-index');
const m722 = require('../../src/db/migrations/722-automation-rule-configurer');
const { withLockTimeout } = require('../../src/db/lockTimeout');

// Migrations 714-719 and 722 read without a database: what each runs, in which
// transaction and under which lock_timeout, that a second run adds nothing,
// that no statement alters `orders`, and that undoing 714 never drops a
// secret kept only sealed.

function recorder({ columns = new Set(), constraints = new Set(), indexes = new Set(), sealedOnly = 0, lockFailures = 0 } = {}) {
  const statements = [];
  let transactions = 0;
  let failuresLeft = lockFailures;
  const sequelize = {
    transaction: async (fn) => {
      transactions += 1;
      return fn({ id: transactions });
    },
    query: async (sql, options = {}) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: text, tx: options.transaction ? options.transaction.id : null });
      if (/information_schema\.columns/.test(text)) {
        const key = `${options.replacements.table}.${options.replacements.column}`;
        return [columns.has(key) ? [{ present: 1 }] : []];
      }
      if (/FROM pg_constraint/.test(text)) return [constraints.has(options.replacements.name) ? [{ x: 1 }] : []];
      if (/FROM pg_class/.test(text)) return [indexes.has(options.bind.name) ? [{ valid: true }] : []];
      if (/signing_secret IS NULL/.test(text)) return [[{ n: sealedOnly }]];
      if (/^ALTER TABLE \S+ ADD CONSTRAINT/.test(text) && failuresLeft > 0) {
        failuresLeft -= 1;
        throw Object.assign(new Error('canceling statement due to lock timeout'), { parent: { code: '55P03' } });
      }
      const added = text.match(/ADD CONSTRAINT (\S+)/);
      if (added) constraints.add(added[1]);
      const dropped = text.match(/DROP CONSTRAINT IF EXISTS (\S+)/);
      if (dropped) constraints.delete(dropped[1]);
      const index = text.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS (\S+)/);
      if (index) indexes.add(index[1]);
      return [[], 0];
    },
  };
  const queryInterface = {
    sequelize,
    addColumn: async (table, column, definition, options = {}) => {
      statements.push({ sql: `ADD ${table}.${column}`, tx: options.transaction ? options.transaction.id : null });
      columns.add(`${table}.${column}`);
    },
    removeColumn: async (table, column, options = {}) => {
      statements.push({ sql: `REMOVE ${table}.${column}`, tx: options.transaction ? options.transaction.id : null });
      columns.delete(`${table}.${column}`);
    },
  };
  const sql = () => statements.map((s) => s.sql);
  return { queryInterface, statements, sql };
}

const Sequelize = { TEXT: 'TEXT', UUID: 'UUID', STRING: (n) => `VARCHAR(${n})` };

/** Every ALTER, CREATE/DROP TABLE and column added or dropped ran inside a transaction that began with SET LOCAL lock_timeout. */
function underLockTimeout(statements) {
  const firstInTx = new Map();
  for (const s of statements) if (s.tx !== null && !firstInTx.has(s.tx)) firstInTx.set(s.tx, s.sql);
  return statements
    .filter((s) => /^(ALTER TABLE|CREATE TABLE|DROP TABLE|ADD |REMOVE )/.test(s.sql))
    .every((s) => s.tx !== null && /^SET LOCAL lock_timeout = '5s'$/.test(firstInTx.get(s.tx)));
}

describe('migration 714 (sealed webhook secrets)', () => {
  it('adds the column and the CHECK once, NOT VALID then validated, under a lock_timeout; nothing is rewritten', async () => {
    const r = recorder();
    await m714.up(r.queryInterface, Sequelize);
    await m714.up(r.queryInterface, Sequelize);
    const sql = r.sql();
    expect(sql.filter((s) => s === 'ADD webhook_endpoints.signing_secret_sealed')).toHaveLength(1);
    expect(sql).toContain('ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret DROP NOT NULL');
    const add = sql.filter((s) => s.startsWith('ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_signing_secret_present'));
    expect(add).toHaveLength(1);
    expect(add[0]).toMatch(/CHECK \(signing_secret IS NOT NULL OR signing_secret_sealed IS NOT NULL\) NOT VALID$/);
    expect(sql.indexOf(add[0])).toBeLessThan(sql.indexOf('ALTER TABLE webhook_endpoints VALIDATE CONSTRAINT webhook_endpoints_signing_secret_present'));
    expect(underLockTimeout(r.statements)).toBe(true);
    expect(sql.some((s) => /^(UPDATE|DELETE|INSERT)\b/i.test(s))).toBe(false);
  });

  it('refuses to go down while a secret is kept only sealed, and says how to put it back', async () => {
    const r = recorder({ columns: new Set(['webhook_endpoints.signing_secret_sealed']), sealedOnly: 2 });
    await expect(m714.down(r.queryInterface)).rejects.toThrow('--unseal --apply');
    expect(r.sql().some((s) => /SET NOT NULL|DROP CONSTRAINT|^REMOVE/.test(s))).toBe(false);
  });

  it('goes down when every secret is in clear (CHECK first), and a second time changes nothing', async () => {
    const r = recorder({ columns: new Set(['webhook_endpoints.signing_secret_sealed']), constraints: new Set(['webhook_endpoints_signing_secret_present']) });
    await m714.down(r.queryInterface);
    await m714.down(r.queryInterface);
    const sql = r.sql();
    expect(sql.filter((s) => s === 'REMOVE webhook_endpoints.signing_secret_sealed')).toHaveLength(1);
    expect(sql.indexOf('ALTER TABLE webhook_endpoints DROP CONSTRAINT IF EXISTS webhook_endpoints_signing_secret_present')).toBeLessThan(
      sql.indexOf('ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret SET NOT NULL')
    );
    expect(underLockTimeout(r.statements)).toBe(true);
  });
});

describe('migrations 715-717', () => {
  it('715 adds a nullable column once and removes it once, each under a lock_timeout', async () => {
    const r = recorder();
    await m715.up(r.queryInterface, Sequelize);
    await m715.up(r.queryInterface, Sequelize);
    await m715.down(r.queryInterface);
    await m715.down(r.queryInterface);
    expect(r.sql().filter((s) => s.startsWith('ADD '))).toEqual(['ADD product_option_choices.external_code']);
    expect(r.sql().filter((s) => s.startsWith('REMOVE '))).toEqual(['REMOVE product_option_choices.external_code']);
    expect(underLockTimeout(r.statements)).toBe(true);
  });

  it('716 and 717 create bare tables, then each foreign key NOT VALID and validated, all under a lock_timeout; never ALTER orders', async () => {
    const r = recorder();
    for (const m of [m716, m717]) {
      await m.up(r.queryInterface);
      await m.up(r.queryInterface);
    }
    const sql = r.sql();
    const creates = sql.filter((s) => s.startsWith('CREATE TABLE'));
    expect(creates.every((s) => s.startsWith('CREATE TABLE IF NOT EXISTS') && !/REFERENCES/.test(s))).toBe(true);
    expect(creates.find((s) => s.includes('api_key_order_acks'))).toContain('PRIMARY KEY (api_key_id, order_id)');
    expect(creates.find((s) => s.includes('order_pos_statuses'))).toContain("CHECK (status IN ('received', 'preparing', 'ready', 'completed'))");

    const fks = [
      ['api_key_order_acks', 'api_key_order_acks_api_key_id_fkey', 'REFERENCES api_keys (id) ON DELETE CASCADE'],
      ['api_key_order_acks', 'api_key_order_acks_order_id_fkey', 'REFERENCES orders (id) ON DELETE CASCADE'],
      ['order_pos_statuses', 'order_pos_statuses_order_id_fkey', 'REFERENCES orders (id) ON DELETE CASCADE'],
      ['order_pos_statuses', 'order_pos_statuses_workspace_id_fkey', 'REFERENCES workspaces (id) ON DELETE CASCADE'],
      ['order_pos_statuses', 'order_pos_statuses_api_key_id_fkey', 'REFERENCES api_keys (id) ON DELETE SET NULL'],
    ];
    for (const [table, name, reference] of fks) {
      const added = sql.filter((s) => s.startsWith(`ALTER TABLE ${table} ADD CONSTRAINT ${name} `));
      expect([name, added.length]).toEqual([name, 1]);
      expect(added[0]).toContain(reference);
      expect(added[0]).toMatch(/ NOT VALID$/);
      expect(sql.indexOf(added[0])).toBeLessThan(sql.indexOf(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`));
    }
    expect(underLockTimeout(r.statements)).toBe(true);
    expect(sql.some((s) => /^ALTER TABLE orders\b/.test(s))).toBe(false);

    for (const m of [m716, m717]) await m.down(r.queryInterface);
    expect(r.sql().filter((s) => s.startsWith('DROP TABLE IF EXISTS'))).toHaveLength(2);
    expect(underLockTimeout(r.statements)).toBe(true);
  });

  it('a step whose lock is not granted in time is tried again; another error is not', async () => {
    const r = recorder({ lockFailures: 2 });
    await m716.up(r.queryInterface);
    expect(r.sql().filter((s) => s.startsWith('ALTER TABLE api_key_order_acks ADD CONSTRAINT api_key_order_acks_api_key_id_fkey'))).toHaveLength(3);

    let calls = 0;
    const failing = {
      transaction: async (fn) => fn({ id: 1 }),
      query: async (sql) => {
        if (/^SET LOCAL/.test(sql)) return [[]];
        calls += 1;
        throw Object.assign(new Error('boom'), { parent: { code: '42P01' } });
      },
    };
    await expect(withLockTimeout(failing, (t) => failing.query('ALTER TABLE x', { transaction: t }), { pauseMs: 0 })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

describe('migration 719 (webhook configurer, feed index)', () => {
  it('adds the column once under a lock_timeout, backfills only nulls from the activity log, builds the index CONCURRENTLY once; down undoes both', async () => {
    const r = recorder();
    await m719.up(r.queryInterface, Sequelize);
    await m719.up(r.queryInterface, Sequelize);
    const sql = r.sql();
    expect(sql.filter((s) => s === 'ADD webhook_endpoints.configured_by_user_id')).toHaveLength(1);
    const backfill = sql.find((s) => s.startsWith('UPDATE webhook_endpoints'));
    expect(backfill).toContain('WHERE e.configured_by_user_id IS NULL');
    expect(backfill).toContain("entity_type = 'WebhookEndpoint'");
    expect(sql.filter((s) => s.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_workspace_updated_at_idx ON orders (workspace_id, updated_at)'))).toHaveLength(1);
    expect(r.statements.filter((s) => /CONCURRENTLY/.test(s.sql)).every((s) => s.tx === null)).toBe(true);

    await m719.down(r.queryInterface);
    expect(r.sql()).toContain('DROP INDEX CONCURRENTLY IF EXISTS orders_workspace_updated_at_idx;');
    expect(r.sql()).toContain('REMOVE webhook_endpoints.configured_by_user_id');
    expect(underLockTimeout(r.statements)).toBe(true);
  });
});

describe('migration 722 (automation configurer)', () => {
  it('adds the column once under a lock_timeout, backfills only nulls from the activity log; down drops it once', async () => {
    const r = recorder();
    await m722.up(r.queryInterface, Sequelize);
    await m722.up(r.queryInterface, Sequelize);
    const sql = r.sql();
    expect(sql.filter((s) => s === 'ADD automation_rules.configured_by_user_id')).toHaveLength(1);
    const backfill = sql.find((s) => s.startsWith('UPDATE automation_rules'));
    expect(backfill).toContain('WHERE r.configured_by_user_id IS NULL');
    expect(backfill).toContain("entity_type = 'AutomationRule'");
    expect(backfill).toContain("(before_state->'actions') IS DISTINCT FROM (after_state->'actions')");
    expect(sql.some((s) => /^ALTER TABLE automation_rules\b/.test(s))).toBe(false);

    await m722.down(r.queryInterface);
    await m722.down(r.queryInterface);
    expect(r.sql().filter((s) => s === 'REMOVE automation_rules.configured_by_user_id')).toHaveLength(1);
    expect(underLockTimeout(r.statements)).toBe(true);
  });
});
