'use strict';

const { MessageType } = require('socket.io-adapter');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const pgPool = require('./pgPool');
const { route } = require('./catalog');

/**
 * Sends to the sockets of every API process through the database: one NOTIFY
 * on the adapter's channel, in the adapter's own message format (the cluster
 * protocol of socket.io-adapter, which @socket.io/postgres-adapter LISTENs
 * for). Whichever process runs the worker publishes; every API process's
 * adapter hands the message to its own sockets.
 *
 * Written here instead of @socket.io/postgres-emitter: its 0.1.1 left the
 * namespace out (the adapter dropped every message), and on a failed NOTIFY it
 * broadcast the error itself to the same room, again and again while the
 * database was down.
 *
 * The format is pinned: socket.io-adapter and @socket.io/postgres-adapter are
 * exact versions in package.json, and tests/integration/realtime.test.js feeds
 * these messages through the adapter, so an upgrade that changes it fails there.
 *
 * Failures never reach a browser. A failed NOTIFY is logged and pauses
 * publishing for at most PAUSE_MAX_MS (with jitter), less than the first retry
 * of the default queue (10 s, core/queue/queues.js): the retried job really
 * asks the database again. Nothing loops. A message over MAX_PAYLOAD_BYTES is
 * not sent and is logged: NOTIFY takes less than 8000 bytes, and the messages
 * are ids only (catalog.js), a few hundred.
 *
 * The messages that end access (control.js) are events for the servers, not
 * for a room: each server ends that account's sockets itself, and remembers
 * when, so a handshake still in progress at that moment is let go too
 * (realtimeServer.js). They do not wait out a pause, and a failed one is tried
 * once more 2 seconds later.
 */

const CHANNEL_PREFIX = 'zimos-realtime';
const NAMESPACE = '/';
const CHANNEL = `${CHANNEL_PREFIX}#${NAMESPACE}`;
// The sender id the adapter knows for a publisher that is not a server: it is not counted as one.
const SENDER = 'emitter';
// socket.io-parser's EVENT packet.
const EVENT_PACKET = 2;
const MAX_PAYLOAD_BYTES = 7000;
const PAUSE_BASE_MS = 500;
const PAUSE_MAX_MS = 5 * 1000;
const CONTROL_RETRY_MS = 2 * 1000;
const RESYNC_EVENT = 'zimos:resync';
// (userId, kind): 'access' ends the account's sockets; 'session' ends those whose session has ended.
const CUT_EVENT = 'zimos:cut';

const messages = {
  /** `name` with `body` to every socket in `room`. */
  broadcast: (room, name, body) => ({
    uid: SENDER,
    nsp: NAMESPACE,
    type: MessageType.BROADCAST,
    data: { opts: { rooms: [room], except: [], flags: {} }, packet: { type: EVENT_PACKET, data: [name, body], nsp: NAMESPACE } },
  }),
  /** An event every server's namespace hears (io.of('/').on(name)), never a client. */
  serverEvent: (name, ...args) => ({
    uid: SENDER,
    nsp: NAMESPACE,
    type: MessageType.SERVER_SIDE_EMIT,
    data: { packet: [name, ...args] },
  }),
};

let failures = 0;
let pausedUntil = 0;

const unavailable = (why) => {
  const err = new Error(`live updates: ${why}`);
  err.code = 'REALTIME_UNAVAILABLE';
  return err;
};

/**
 * Sends one message. Resolves false when it is too big to send; rejects (with
 * no database detail) when the database refused it, or while publishing is
 * paused after a failure — unless `ignorePause`.
 */
async function send(message, { ignorePause = false } = {}) {
  const payload = JSON.stringify(message);
  const bytes = Buffer.byteLength(payload);
  if (bytes > MAX_PAYLOAD_BYTES) {
    logger.error(`[realtime] message of type ${message.type} not sent: ${bytes} bytes, over ${MAX_PAYLOAD_BYTES}`);
    return false;
  }
  if (!ignorePause && Date.now() < pausedUntil) throw unavailable('publishing paused after a failure');
  try {
    await pgPool.get().pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
  } catch (err) {
    failures += 1;
    const cap = Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** (failures - 1));
    const wait = Math.round(cap * (0.5 + Math.random() / 2));
    pausedUntil = Date.now() + wait;
    logger.warn(`[realtime] publish failed (${err.code || err.message}); paused for ${wait} ms`);
    throw unavailable('publish failed');
  }
  failures = 0;
  pausedUntil = 0;
  return true;
}

/** An outbox event to its room (catalog.js). Rejects on a database failure, so its queue job is retried. */
async function publish(event) {
  if (!env.realtime.enabled) return false;
  const routed = route(event);
  if (!routed) return false;
  return send(messages.broadcast(routed.room, routed.name, routed.message));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** A message that ends access: through a pause, and once more after CONTROL_RETRY_MS if it fails. Never throws. */
async function sendControl(message, what) {
  try {
    return await send(message, { ignorePause: true });
  } catch {
    await sleep(CONTROL_RETRY_MS);
    try {
      return await send(message, { ignorePause: true });
    } catch (err) {
      logger.warn(`[realtime] could not ${what}, the periodic checks will: ${err.message}`);
      return false;
    }
  }
}

/** Ends every socket of this account, on every server. */
function cutAccess(userId) {
  if (!env.realtime.enabled || !userId) return Promise.resolve(false);
  return sendControl(messages.serverEvent(CUT_EVENT, userId, 'access'), 'end the sockets of an account');
}

/** Every server ends this account's sockets whose session has ended, and only those. */
function checkSessionsOf(userId) {
  if (!env.realtime.enabled || !userId) return Promise.resolve(false);
  return sendControl(messages.serverEvent(CUT_EVENT, userId, 'session'), "check an account's sessions");
}

/** Every server checks its sockets' sessions and rooms now. */
function resyncAll() {
  if (!env.realtime.enabled) return Promise.resolve(false);
  return sendControl(messages.serverEvent(RESYNC_EVENT), 'ask the servers to check their sockets');
}

/** Forgets a pause after a failure (tests, and before the pool is ended). */
function reset() {
  failures = 0;
  pausedUntil = 0;
}

module.exports = {
  publish,
  send,
  cutAccess,
  checkSessionsOf,
  resyncAll,
  reset,
  messages,
  CHANNEL_PREFIX,
  CHANNEL,
  RESYNC_EVENT,
  CUT_EVENT,
  MAX_PAYLOAD_BYTES,
  PAUSE_MAX_MS,
  CONTROL_RETRY_MS,
};
