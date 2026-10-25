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
 * One LISTEN connection at a time: the adapter can ask for a new one twice
 * after a single drop (from the client's 'end' and from its own catch), and
 * two would deliver every message twice. A new one retires the one before:
 * the adapter's listeners come off it and it is ended.
 *
 * `isListening()` is true once a LISTEN has succeeded on the current
 * connection and until it ends; `onListening(fn)` hears each change. The
 * socket server lets its sockets go while it is down (realtimeServer.js), so
 * the dashboard polls instead of trusting a connection that delivers nothing.
 *
 * After a drop the adapter asks for a new LISTEN connection on its own (on
 * the client's 'end', and after every failed attempt, 1 to 3 seconds later).
 * While the database stays down, each further attempt first waits longer,
 * doubling up to LISTEN_BACKOFF_MAX_MS, with jitter; the count of failures
 * starts again only once a LISTEN succeeds, not on a mere connect.
 *
 * A connection that dies without telling (a NAT or a proxy dropping it
 * silently): TCP keepalive starts after KEEPALIVE_DELAY_MS, and something has
 * to come through LISTEN — the adapter NOTIFYs its own heartbeat every few
 * seconds — so a connection that has heard nothing for `listenIdleMs` is
 * ended, and the adapter connects again.
 */

const POOL_MAX = 2;
const CONNECT_TIMEOUT_MS = 5000;
const KEEPALIVE_DELAY_MS = 10 * 1000;
const LISTEN_IDLE_MS = 30 * 1000;
const LISTEN_BACKOFF_BASE_MS = 1000;
const LISTEN_BACKOFF_MAX_MS = 30000;
const WATCHDOG = Symbol('realtime listen watchdog');

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
const stopping = () => new Error('live updates are stopping');

/** A set of connections. `name` becomes the application_name the database shows. */
function createConnections({ name = 'zimos-realtime', listenIdleMs = LISTEN_IDLE_MS } = {}) {
  const pool = new Pool({ ...settings(name), max: POOL_MAX, idleTimeoutMillis: 10000 });
  // An idle pooled connection that drops must not end the process.
  pool.on('error', (err) => logger.warn(`[realtime] database connection lost: ${err.message}`));

  let current = null;
  let listening = false;
  let failures = 0;
  let closed = false;
  const watchers = new Set();
  const stats = { connects: 0, retired: 0, silentEnds: 0 };

  function setListening(next) {
    if (next === listening) return;
    listening = next;
    for (const fn of watchers) {
      try {
        fn(next);
      } catch (err) {
        logger.warn(`[realtime] listener of the LISTEN state failed: ${err.message}`);
      }
    }
  }

  function forget(client) {
    clearInterval(client[WATCHDOG]);
    if (current === client) {
      current = null;
      setListening(false);
    }
  }

  /** A connection that is not the one any more: what the adapter put on it comes off, then it is ended. */
  function retire(client) {
    forget(client);
    client.removeAllListeners('notification');
    client.removeAllListeners('end');
    stats.retired += 1;
    client.end().catch(() => {});
  }

  async function connect() {
    if (closed) throw stopping();
    const wait = listenBackoffMs(failures);
    if (wait > 0) await sleep(wait);
    if (closed) throw stopping();
    if (current) retire(current);
    const client = new Client({ ...settings(`${name}-listen`), keepAlive: true, keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS });
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
      throw stopping();
    }
    // Another attempt may have finished while this one connected: the last one wins.
    if (current) retire(current);
    current = client;
    stats.connects += 1;

    // It works once its LISTEN does: only then is the count of failures forgiven and the state live.
    const query = client.query.bind(client);
    client.query = (text, ...rest) => {
      const result = query(text, ...rest);
      if (typeof text === 'string' && text.startsWith('LISTEN') && result && typeof result.then === 'function') {
        result.then(
          () => {
            if (current !== client) return;
            if (failures > 0) logger.info(`[realtime] LISTEN back after ${failures} failed attempt(s)`);
            failures = 0;
            setListening(true);
          },
          () => {
            if (current === client) failures += 1;
          }
        );
      }
      return result;
    };

    // Something must come through: the adapter's heartbeat is NOTIFYed every few seconds.
    let lastHeard = Date.now();
    client.on('notification', () => {
      lastHeard = Date.now();
    });
    client[WATCHDOG] = setInterval(() => {
      if (Date.now() - lastHeard <= listenIdleMs) return;
      stats.silentEnds += 1;
      logger.warn(`[realtime] LISTEN connection silent for ${Math.round((Date.now() - lastHeard) / 1000)} s, ending it`);
      forget(client);
      client.end().catch(() => {});
    }, Math.min(listenIdleMs, 10 * 1000));
    client[WATCHDOG].unref();

    client.once('end', () => forget(client));
    // The adapter "releases" its LISTEN client when it closes: this one is ended, never pooled.
    client.release = () => {
      forget(client);
      client.end().catch(() => {});
    };
    return client;
  }

  return {
    pool,
    forAdapter: { connect, query: (...args) => pool.query(...args) },
    isListening: () => listening,
    /** Calls `fn(isListening)` on every change; returns the way to stop. */
    onListening(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    listeners: () => (current ? [current] : []),
    stats: () => ({ ...stats }),
    async end() {
      closed = true;
      watchers.clear();
      if (current) {
        const last = current;
        forget(last);
        await last.end().catch(() => {});
      }
      await pool.end();
    },
  };
}

let defaults = null;

/** This process's connections (created on first use). */
function get() {
  if (!defaults) defaults = createConnections();
  return defaults;
}

async function end() {
  if (!defaults) return;
  const closing = defaults;
  defaults = null;
  await closing.end();
}

module.exports = { get, end, createConnections, listenBackoffMs, CONNECT_TIMEOUT_MS, LISTEN_BACKOFF_MAX_MS, LISTEN_IDLE_MS };
