'use strict';

const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const pgPool = require('./pgPool');
const publisher = require('./publisher');
const { createRealtimeServer, PATH } = require('./realtimeServer');

/**
 * The live updates (REALTIME_ENABLED): a socket server on the API's HTTP
 * server, fed by the outbox consumer in jobs.js. See realtimeServer.js for
 * who gets in, catalog.js for what is sent to whom.
 *
 *   server.js   attach(server, app) after listen; stop() then release() on shutdown
 *   worker.js   release() on shutdown (it only publishes)
 */

let running = null;

/** Starts the socket server on `httpServer` while REALTIME_ENABLED is on; otherwise nothing. */
function attach(httpServer, app) {
  if (!env.realtime.enabled || running) return running;
  running = createRealtimeServer(httpServer, { app, pool: pgPool.get() });
  logger.info(`Live updates on ${PATH} (websocket only)`);
  return running;
}

/** Closes the connections first: the HTTP server cannot close while they are open. */
async function stop() {
  if (!running) return;
  const current = running;
  running = null;
  try {
    await current.stop();
  } catch (err) {
    logger.warn(`[realtime] stop: ${err.message}`);
  }
}

/** Ends the database pool, once nothing publishes any more (after the worker stops). */
async function release() {
  publisher.reset();
  try {
    await pgPool.end();
  } catch (err) {
    logger.warn(`[realtime] release: ${err.message}`);
  }
}

module.exports = { attach, stop, release, PATH };
