'use strict';

const m714 = require('../../src/db/migrations/714-webhook-secret-sealed');
const m715 = require('../../src/db/migrations/715-option-choice-external-code');
const m716 = require('../../src/db/migrations/716-create-api-key-order-acks');
const m717 = require('../../src/db/migrations/717-create-order-pos-statuses');

// Migrations 714-717 read without a database: what each runs, that a second
// run adds nothing, and that undoing 714 never drops a secret kept only sealed.

function recorder({ columns = new Set(), sealedOnly = 0 } = {}) {
  const statements = [];
  const queryInterface = {
    sequelize: {
      query: async (sql, options = {}) => {
        const text = sql.replace(/\s+/g, ' ').trim();
        statements.push(text);
        if (/information_schema\.columns/.test(text)) {
          const key = `${options.replacements.table}.${options.replacements.column}`;
          return [columns.has(key) ? [{ present: 1 }] : []];
        }
        if (/signing_secret IS NULL/.test(text)) return [[{ n: sealedOnly }]];
        return [[], 0];
      },
    },
    addColumn: async (table, column) => {
      statements.push(`ADD ${table}.${column}`);
      columns.add(`${table}.${column}`);
    },
    removeColumn: async (table, column) => {
      statements.push(`REMOVE ${table}.${column}`);
      columns.delete(`${table}.${column}`);
    },
  };
  return { queryInterface, statements };
}

const Sequelize = { TEXT: 'TEXT', STRING: (n) => `VARCHAR(${n})` };

describe('migration 714 (sealed webhook secrets)', () => {
  it('adds the column once and lets the clear secret be null; nothing is rewritten', async () => {
    const r = recorder();
    await m714.up(r.queryInterface, Sequelize);
    await m714.up(r.queryInterface, Sequelize);
    expect(r.statements.filter((s) => s === 'ADD webhook_endpoints.signing_secret_sealed')).toHaveLength(1);
    expect(r.statements).toContain('ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret DROP NOT NULL');
    expect(r.statements.some((s) => /^(UPDATE|DELETE|INSERT)\b/i.test(s))).toBe(false);
  });

  it('refuses to go down while a secret is kept only sealed, and says how to put it back', async () => {
    const r = recorder({ columns: new Set(['webhook_endpoints.signing_secret_sealed']), sealedOnly: 2 });
    await expect(m714.down(r.queryInterface)).rejects.toThrow('--unseal --apply');
    expect(r.statements.some((s) => /SET NOT NULL|^REMOVE/.test(s))).toBe(false);
  });

  it('goes down when every secret is in clear, and a second time changes nothing', async () => {
    const r = recorder({ columns: new Set(['webhook_endpoints.signing_secret_sealed']) });
    await m714.down(r.queryInterface);
    await m714.down(r.queryInterface);
    expect(r.statements.filter((s) => s === 'REMOVE webhook_endpoints.signing_secret_sealed')).toHaveLength(1);
    expect(r.statements).toContain('ALTER TABLE webhook_endpoints ALTER COLUMN signing_secret SET NOT NULL');
  });
});

describe('migrations 715-717', () => {
  it('715 adds a nullable column once and removes it once', async () => {
    const r = recorder();
    await m715.up(r.queryInterface, Sequelize);
    await m715.up(r.queryInterface, Sequelize);
    await m715.down(r.queryInterface);
    await m715.down(r.queryInterface);
    expect(r.statements.filter((s) => s.startsWith('ADD '))).toEqual(['ADD product_option_choices.external_code']);
    expect(r.statements.filter((s) => s.startsWith('REMOVE '))).toEqual(['REMOVE product_option_choices.external_code']);
  });

  it('716 and 717 create new tables only, each harmless the second time', async () => {
    const r = recorder();
    for (const m of [m716, m717]) {
      await m.up(r.queryInterface);
      await m.down(r.queryInterface);
    }
    const sql = r.statements;
    expect(sql.every((s) => /^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|DROP TABLE IF EXISTS) /.test(s))).toBe(true);
    expect(sql.some((s) => /\borders\b/.test(s) && /^ALTER/.test(s))).toBe(false);
    expect(sql.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS api_key_order_acks'))).toContain('PRIMARY KEY (api_key_id, order_id)');
    expect(sql.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS order_pos_statuses'))).toContain(
      "CHECK (status IN ('received', 'preparing', 'ready', 'completed'))"
    );
  });
});
