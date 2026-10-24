'use strict';

const { Emitter } = require('@socket.io/postgres-emitter');
const env = require('../../config/env');
const pgPool = require('./pgPool');
const { route } = require('./catalog');

/**
 * Sends an outbox event to its room, from whichever process runs the worker
 * (the API with WORKER_IN_PROCESS, or src/worker.js): the emitter NOTIFYs
 * and every API process's socket adapter, listening, hands the message to its
 * own sockets in that room.
 *
 * The emitter sends in the background and keeps its errors to itself, so a
 * message lost to a database hiccup is not retried. The dashboard fetches
 * again whenever it reconnects, which covers it.
 */

const ATTACHMENTS_TABLE = 'socket_io_attachments';
const NAMESPACE = '/';

/**
 * The pool the emitter is given. @socket.io/postgres-emitter 0.1.1 leaves the
 * namespace out of what it NOTIFYs, and the adapter's cluster base
 * (socket.io-adapter 2.5.x, under @socket.io/postgres-adapter 0.4 and later)
 * drops any message whose `nsp` is not its own — so without this nothing it
 * sends is ever delivered. This puts `nsp` back on the NOTIFY payload and
 * leaves every other query as it is. The messages here are ids only, far below
 * the 8000-byte NOTIFY limit, so the emitter's attachment path (which this does
 * not touch) is never taken.
 */
function withNamespace(pool) {
  return {
    query(text, values) {
      if (/^SELECT pg_notify\(\$1, \$2\)$/.test(text) && Array.isArray(values) && typeof values[1] === 'string') {
        try {
          const message = JSON.parse(values[1]);
          if (message && typeof message === 'object' && message.nsp === undefined) {
            return pool.query(text, [values[0], JSON.stringify({ ...message, nsp: NAMESPACE })]);
          }
        } catch {
          /* not JSON: sent as it is */
        }
      }
      return pool.query(text, values);
    },
  };
}

let emitter = null;

function publish(event) {
  if (!env.realtime.enabled) return false;
  const routed = route(event);
  if (!routed) return false;
  if (!emitter) emitter = new Emitter(withNamespace(pgPool.get()), NAMESPACE, { tableName: ATTACHMENTS_TABLE });
  emitter.to(routed.room).emit(routed.name, routed.message);
  return true;
}

/** Forgets the emitter, before its pool is ended. */
function reset() {
  emitter = null;
}

module.exports = { publish, reset, withNamespace, ATTACHMENTS_TABLE };
