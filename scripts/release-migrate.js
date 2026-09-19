'use strict';

/**
 * Runs pending migrations as a deploy step, before the server starts.
 *
 * This exists because a deploy that ships new migration files but never runs
 * them leaves the API serving a schema it was not written against — every
 * route that touches a new column 500s with "An unexpected error occurred",
 * and nothing in the deploy log says why. Running it here makes that failure
 * mode impossible: if the migrations cannot be applied, this exits non-zero,
 * the container never starts, and the deploy fails loudly instead.
 *
 * Usage:
 *   node scripts/release-migrate.js          # migrate, then exit 0
 *   npm run migrate:deploy                   # same thing
 *
 * In the image it runs from scripts/start.sh, which then execs the server.
 *
 * Connection settings come from src/config/sequelize-cli.js — the same file
 * the CLI itself reads — so there is no second place to keep DATABASE_URL /
 * DB_SSL handling in sync.
 *
 * Two things worth knowing:
 *
 *  - Concurrency. Rolling deploys and multi-replica services start several
 *    containers at once, and "SequelizeMeta" has no locking of its own: two
 *    processes can both read a migration as pending and both try to apply it.
 *    So this takes a Postgres session-level advisory lock first. Whoever gets
 *    it migrates; the others wait, then find nothing pending and move on.
 *
 *  - Escape hatch. RUN_MIGRATIONS=false skips the whole step, for the case
 *    where you need the API back up while a bad migration is sorted out by
 *    hand. It is deliberately loud in the logs.
 */

const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');

// Arbitrary but fixed: every deploy of this app must pick the same number, or
// the lock protects nothing. Do not change it.
const LOCK_KEY = 7222081;

// How long to wait for another container's migration run before giving up.
// Long enough for a slow index build, short enough that a genuinely stuck
// lock fails the deploy instead of hanging it forever.
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 2000;

const nodeEnv = process.env.NODE_ENV || 'development';

function log(message) {
  console.log(`[release-migrate] ${message}`);
}

function connectionFor(environment) {
  // Resolved by the CLI's own config module, so DATABASE_URL beats DB_*,
  // sslmode in the URL is honoured, and DB_SSL=true still forces SSL on.
  const config = require('../src/config/sequelize-cli')[environment];
  if (!config) throw new Error(`No sequelize config for NODE_ENV="${environment}"`);

  const ssl = config.dialectOptions && config.dialectOptions.ssl ? { rejectUnauthorized: false } : false;
  return {
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl,
  };
}

async function withAdvisoryLock(client, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let waited = false;

  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    if (rows[0].locked) break;

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${LOCK_TIMEOUT_MS / 1000}s waiting for the migration lock. ` +
          'Another deploy may still be migrating, or a previous run died holding it.'
      );
    }
    if (!waited) {
      log('Another process is migrating — waiting for it to finish.');
      waited = true;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }

  try {
    return await fn();
  } finally {
    // Session-level locks die with the connection anyway; this just returns it
    // promptly so a waiting container is not held up by our teardown.
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }
}

function runMigrations() {
  return new Promise((resolve, reject) => {
    // Spawn the CLI's entry file with this same node binary rather than going
    // through `npx`: no network lookup, no shell, works the same on Windows.
    const cli = require.resolve('sequelize-cli/lib/sequelize');
    const child = spawn(process.execPath, [cli, 'db:migrate', '--env', nodeEnv], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit',
      env: process.env,
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(signal ? `Migrations killed by signal ${signal}` : `Migrations exited with code ${code}`));
    });
  });
}

async function main() {
  if (process.env.RUN_MIGRATIONS === 'false') {
    log('RUN_MIGRATIONS=false — SKIPPING migrations. The schema may be behind the code.');
    return;
  }

  const connection = connectionFor(nodeEnv);
  log(`Migrating ${connection.database} at ${connection.host}:${connection.port} (env: ${nodeEnv})`);

  const client = new Client(connection);
  await client.connect();

  try {
    await withAdvisoryLock(client, runMigrations);
    log('Migrations up to date.');
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[release-migrate] FAILED: ${err.message}`);
  console.error('[release-migrate] Refusing to start the server against a schema the code was not written for.');
  process.exit(1);
});
