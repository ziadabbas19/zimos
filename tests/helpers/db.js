'use strict';

const db = require('../../src/db/models');

/**
 * Truncates every application table between tests (CASCADE to also clear
 * join rows), but leaves the schema itself alone — migrations run once per
 * test-DB setup, not per test. SequelizeMeta is excluded since it tracks
 * which migrations have run.
 */
async function truncateAll(attempt = 1) {
  const tables = Object.values(db.sequelize.models).map((m) => `"${m.getTableName()}"`);
  if (tables.length === 0) return;
  try {
    await db.sequelize.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE;`);
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
