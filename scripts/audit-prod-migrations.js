'use strict';

/**
 * READ-ONLY production migration audit.
 *
 * Compares the migration files in src/db/migrations against the rows in the
 * target database's "SequelizeMeta" table, and physically checks a handful of
 * drift-prone columns/tables. It NEVER writes: the DB session is pinned to
 * `default_transaction_read_only = on` and every statement is a SELECT.
 *
 * Usage (run it yourself, when you're awake and watching):
 *
 *   # point DATABASE_URL at PRODUCTION for this one command only
 *   DATABASE_URL="postgresql://USER:PASS@HOST:PORT/DB" DB_SSL=true \
 *     node scripts/audit-prod-migrations.js
 *
 * It prints:
 *   - which of the local migration files are recorded as applied
 *   - which are PENDING (on disk but not in SequelizeMeta)
 *   - whether the manually-added notification_logs.attempts column exists
 *   - the exact, reviewed commands to reconcile + finish the migration
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { parseDbUrl } = require('../src/config/parseDbUrl');

const MIGRATIONS_DIR = path.resolve(__dirname, '../src/db/migrations');

// Columns/tables worth a direct physical check regardless of SequelizeMeta,
// because they're the ones a manual hot-patch would have touched.
const PHYSICAL_CHECKS = [
  { migration: '076-add-attempts-to-notification-logs.js', table: 'notification_logs', column: 'attempts' },
  { migration: '075-add-product-code-to-products.js', table: 'products', column: 'product_code' },
  { migration: '074-add-tracking-code-to-shipments.js', table: 'shipments', column: 'tracking_code' },
  { migration: '072-add-phone-verified-to-users.js', table: 'users', column: 'phone_verified_at' },
  { migration: '071-create-otp-codes.js', table: 'otp_codes', column: null },
  { migration: '067-add-google-id-to-users.js', table: 'users', column: 'google_id' },
  { migration: '059-create-verification_tokens.js', table: 'verification_tokens', column: null },
  { migration: '056-create-notification_logs.js', table: 'notification_logs', column: null },
];

function localMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Set it to the target (production) connection string and re-run.');
    process.exit(1);
  }

  const parsed = parseDbUrl(url);
  const ssl = parsed.ssl || process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;
  const client = new Client({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.name,
    ssl,
  });

  await client.connect();
  // Belt and braces: make it impossible for this connection to write.
  await client.query('SET default_transaction_read_only = on');
  await client.query('SET statement_timeout = 15000');

  console.log('='.repeat(72));
  console.log(`READ-ONLY migration audit against  ${parsed.user}@${parsed.host}:${parsed.port}/${parsed.name}`);
  console.log('='.repeat(72));

  // --- SequelizeMeta ----------------------------------------------------
  let applied = [];
  try {
    const { rows } = await client.query('SELECT name FROM "SequelizeMeta" ORDER BY name');
    applied = rows.map((r) => r.name);
  } catch (err) {
    console.error('\nCould not read "SequelizeMeta":', err.message);
    console.error('If the table does not exist, this DB has never been migrated by sequelize-cli.');
    await client.end();
    process.exit(1);
  }

  const files = localMigrations();
  const appliedSet = new Set(applied);
  const fileSet = new Set(files);

  const pending = files.filter((f) => !appliedSet.has(f));
  const orphanMeta = applied.filter((n) => !fileSet.has(n));

  console.log(`\nLocal migration files : ${files.length}`);
  console.log(`Recorded in SequelizeMeta: ${applied.length}`);
  console.log(`\n--- PENDING (on disk, NOT recorded as applied) ---`);
  if (pending.length === 0) {
    console.log('  (none — SequelizeMeta already lists every local migration)');
  } else {
    pending.forEach((f) => console.log(`  ${f}`));
  }

  if (orphanMeta.length) {
    console.log(`\n--- Recorded in SequelizeMeta but NO local file (investigate) ---`);
    orphanMeta.forEach((n) => console.log(`  ${n}`));
  }

  // --- Physical column/table checks -----------------------------------
  console.log(`\n--- Physical schema checks (does the object actually exist?) ---`);
  for (const chk of PHYSICAL_CHECKS) {
    let exists;
    if (chk.column) {
      const { rows } = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [chk.table, chk.column]
      );
      exists = rows.length > 0;
      console.log(
        `  ${exists ? 'present ' : 'MISSING '}  ${chk.table}.${chk.column}` +
          `   (${chk.migration})  ${appliedSet.has(chk.migration) ? '[meta: applied]' : '[meta: NOT applied]'}`
      );
    } else {
      const { rows } = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
        [chk.table]
      );
      exists = rows.length > 0;
      console.log(
        `  ${exists ? 'present ' : 'MISSING '}  table ${chk.table}` +
          `   (${chk.migration})  ${appliedSet.has(chk.migration) ? '[meta: applied]' : '[meta: NOT applied]'}`
      );
    }
  }

  // --- Recommendation -------------------------------------------------
  console.log(`\n${'='.repeat(72)}`);
  console.log('RECOMMENDATION');
  console.log('='.repeat(72));

  const attemptsChk = PHYSICAL_CHECKS[0];
  const attemptsColExists = (
    await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='notification_logs' AND column_name='attempts'`
    )
  ).rows.length > 0;
  const attemptsMetaMissing = !appliedSet.has(attemptsChk.migration);

  if (attemptsColExists && attemptsMetaMissing) {
    console.log(`
notification_logs.attempts EXISTS physically but migration
${attemptsChk.migration} is NOT in SequelizeMeta (your manual ALTER TABLE).
Record it as applied so 'db:migrate' does not try to re-add the column:

    INSERT INTO "SequelizeMeta" (name)
    VALUES ('${attemptsChk.migration}');
`);
  } else if (!attemptsColExists && attemptsMetaMissing) {
    console.log(`
notification_logs.attempts is missing AND unrecorded — a normal 'db:migrate'
run will add it. No manual INSERT needed.`);
  } else {
    console.log(`
notification_logs.attempts is already reconciled (column exists, migration recorded).`);
  }

  if (pending.length) {
    const stillPending = pending.filter((f) => f !== attemptsChk.migration || !attemptsColExists);
    console.log(`
After any INSERT above, apply the remaining ${stillPending.length} pending migration(s)
with sequelize-cli pointed at this same database:

    DATABASE_URL="<this same production URL>" DB_SSL=true NODE_ENV=production \\
      npx sequelize-cli db:migrate

That will run, in order:
${stillPending.map((f) => `      ${f}`).join('\n')}

Review each of those files first. Note the ones that backfill + SET NOT NULL
(074 shipments.tracking_code, 075 products.product_code) touch every existing
row, and 068 does ALTER TYPE ... ADD VALUE on the discounts status enum.
Take a database snapshot before running.`);
  } else {
    console.log(`\nNo pending migrations. Schema is in sync with the migration files.`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
