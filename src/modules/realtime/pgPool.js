'use strict';

const { Client, Pool } = require('pg');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * The live updates' own database connections, apart from Sequelize's, created
 * on first use so a process with REALTIME_ENABLED off never opens one:
 *
 *  - `pool`: a small pool for NOTIFY (publisher.js, and the adapter's own
 *    heartbeat and attachments clean-up). A query waits at most
 *    CONNECT_TIMEOUT_MS for a connection, so a database that is down fails
 *    the publish instead of holding it.
 *  - `forAdapter`: what @socket.io/postgres-adapter is given as its "pool".
 *    Its queries go to the pool above, but `connect()` (the adapter's one
 *    long-lived LISTEN connection) is a dedicated client outside the pool.
 *
 * Why dedicated: a pooled client handed out by `pg-pool` has no 'error'
 * listener, and the adapter adds none. When the LISTEN connection drops (a
 * database restart, a failover, a network reset), `pg` emits 'error' on it
 * with nobody listening and the whole API process crashes; and even with a
 * listener, the adapter forgets the dead client without releasing it, so the
 * pool runs dry and LISTEN never comes back. Here the client always has an
 * 'error' listener, and is closed, not returned, when the adapter lets it go.
 *
 * After a drop the adapter asks for a new LISTEN connection on its own (on
 * the client's 'end', and after every failed attempt, 1 to 3 seconds later).
 * While the database stays down, each further attempt first waits longer,
 * doubling up to LISTEN_BACKOFF_MAX_MS, with jitter so the API processes do
 * not all knock at once. The live updates stop while it is down; the API and
 * everything else carry on.
 */

const POOL_MAX = 2;
const CONNECT_TIMEOUT_MS = 5000;
const LISTEN_BACKOFF_BASE_MS = 1000;
const LISTEN_BACKOFF_MAX_MS = 30000;

function settings(applicationName) {
  return {
    host: env.db.host,
    port: env.db.port,
    database: env.db.name,
    user: env.db.user,
    password: env.db.password,
    ssl: env.db.ssl ? { require: true, rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: applicationName,
  };
}

/** The wait before the next LISTEN attempt after `failures` failed ones: doubling, capped, ±50% jitter. */
function listenBackoffMs(failures) {
  if (failures < 1) return 0;
  const base = Math.min(LISTEN_BACKOFF_MAX_MS, LISTEN_BACKOFF_BASE_MS * 2 ** (failures - 1));
  return Math.round(base * (0.5 + Math.random()));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** A set of connections. `name` becomes the application_name the database shows. */
function createConnections({ name = 'zimos-realtime' } = {}) {
  const pool = new Pool({ ...settings(name), max: POOL_MAX, idleTimeoutMillis: 10000 });
  // An idle pooled connection that drops must not end the process.
  pool.on('error', (err) => logger.warn(`[realtime] database connection lost: ${err.message}`));

  const listening = new Set();
  let failures = 0;
  let closed = false;

  async function connect() {
    if (closed) throw new Error('live updates are stopping');
    const wait = listenBackoffMs(failures);
    if (wait > 0) await sleep(wait);
    if (closed) throw new Error('live updates are stopping');
    const client = new Client({ ...settings(`${name}-listen`), keepAlive: true });
    client.on('error', (err) => logger.warn(`[realtime] LISTEN connection error: ${err.message}`));
    try {
      await client.connect();
    } catch (err) {
      failures += 1;
      logger.warn(`[realtime] LISTEN connection failed (attempt ${failures}), trying again: ${err.message}`);
      client.end().catch(() => {});
      throw err;
    }
    if (closed) {
      client.end().catch(() => {});
      throw new Error('live updates are stopping');
    }
    if (failures > 0) logger.info(`[realtime] LISTEN connection back after ${failures} failed attempt(s)`);
    failures = 0;
    listening.add(client);
    client.once('end', () => listening.delete(client));
    // The adapter "releases" its LISTEN client when it closes: this one is ended, never pooled.
    client.release = () => {
      listening.delete(client);
      client.end().catch(() => {});
    };
    return client;
  }

  return {
    pool,
    forAdapter: { connect, query: (...args) => pool.query(...args) },
    listeners: () => [...listening],
    async end() {
      closed = true;
      await Promise.all([...listening].map((client) => client.end().catch(() => {})));
      listening.clear();
      await pool.end();
    },
  };
}

let current = null;

/** This process's connections (created on first use). */
function get() {
  if (!current) current = createConnections();
  return current;
}

async function end() {
  if (!current) return;
  const closing = current;
  current = null;
  await closing.end();
}

module.exports = { get, end, createConnections, listenBackoffMs, CONNECT_TIMEOUT_MS, LISTEN_BACKOFF_MAX_MS };
