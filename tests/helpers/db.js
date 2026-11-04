'use strict';

const db = require('../../src/db/models');

// Reference data a migration seeds: truncating it would leave every later test
// without it. Nothing it holds points at other tables, so the CASCADE below
// never reaches it either.
const SEEDED_TABLES = new Set(['platform_roles']);

/**
 * Truncates every application table between tests (CASCADE to also clear
 * join rows), but leaves the schema itself alone — migrations run once per
 * test-DB setup, not per test. SequelizeMeta is excluded since it tracks
 * which migrations have run, and so are the SEEDED_TABLES above.
 */
async function truncateAll(attempt = 1) {
  const tables = Object.values(db.sequelize.models)
    .map((m) => m.getTableName())
    .filter((name) => !SEEDED_TABLES.has(name))
    .map((name) => `"${name}"`);
  if (tables.length === 0) return;
  try {
    await db.sequelize.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE;`);
    // The seeded roles stay; a custom role a test made does not.
    await db.sequelize.query(`DELETE FROM platform_roles WHERE key NOT IN ('creator', 'admin', 'agent');`);
  } catch (err) {
    // TRUNCATE takes ACCESS EXCLUSIVE on every table; under any concurrent DB
    // access it can lose a lock race (40P01 deadlock_detected / 55P03
    // lock_not_available). That's transient — back off and retry a few times.
    const code = ((err && (err.parent || err.original)) || err || {}).code;
    if ((code === '40P01' || code === '55P03') && attempt <= 5) {
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
      return truncateAll(attempt + 1);
    }
    throw err;
  }
}

module.exports = { truncateAll };
