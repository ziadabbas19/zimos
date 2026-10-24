'use strict';

const { Pool } = require('pg');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * The live updates' own small pool of database connections, apart from
 * Sequelize's: the socket adapter keeps one connection open for LISTEN, and
 * NOTIFY (the adapter's heartbeat, the emitter's messages) uses the others.
 * The same database settings as db/connection.js. Created on first use, so a
 * process with REALTIME_ENABLED off never opens it.
 */

const MAX_CONNECTIONS = 3;

let pool = null;

function get() {
  if (!pool) {
    pool = new Pool({
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
      ssl: env.db.ssl ? { require: true, rejectUnauthorized: false } : undefined,
      max: MAX_CONNECTIONS,
      idleTimeoutMillis: 10000,
      application_name: 'zimos-realtime',
    });
    // An idle connection that drops must not end the process; the adapter connects again on its own.
    pool.on('error', (err) => logger.warn(`[realtime] database connection lost: ${err.message}`));
  }
  return pool;
}

async function end() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

module.exports = { get, end, MAX_CONNECTIONS };
