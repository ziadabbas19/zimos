'use strict';

const { MessageType } = require('socket.io-adapter');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const pgPool = require('./pgPool');
const { route, userRoom } = require('./catalog');

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
 * publishing (doubling up to PAUSE_MAX_MS, with jitter); the caller's queue job
 * is retried by its queue's policy (core/queue/queues.js), and nothing loops.
 * A message over MAX_PAYLOAD_BYTES is not sent and is logged: NOTIFY takes less
 * than 8000 bytes, and the messages are ids only (catalog.js), a few hundred.
 */

const CHANNEL_PREFIX = 'zimos-realtime';
const NAMESPACE = '/';
const CHANNEL = `${CHANNEL_PREFIX}#${NAMESPACE}`;
// The sender id the adapter knows for a publisher that is not a server: it is not counted as one.
const SENDER = 'emitter';
// socket.io-parser's EVENT packet.
const EVENT_PACKET = 2;
const MAX_PAYLOAD_BYTES = 7000;
const PAUSE_BASE_MS = 1000;
const PAUSE_MAX_MS = 30 * 1000;
const RESYNC_EVENT = 'zimos:resync';

const messages = {
  /** `name` with `body` to every socket in `room`. */
  broadcast: (room, name, body) => ({
    uid: SENDER,
    nsp: NAMESPACE,
    type: MessageType.BROADCAST,
    data: { opts: { rooms: [room], except: [], flags: {} }, packet: { type: EVENT_PACKET, data: [name, body], nsp: NAMESPACE } },
  }),
  /** Closes every socket in `room`, on every server. */
  disconnect: (room) => ({
    uid: SENDER,
    nsp: NAMESPACE,
    type: MessageType.DISCONNECT_SOCKETS,
    data: { opts: { rooms: [room], except: [] }, close: true },
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

/** Sends one message. Resolves false when it is too big to send; rejects (with no database detail) when the database refused it. */
async function send(message) {
  const payload = JSON.stringify(message);
  const bytes = Buffer.byteLength(payload);
  if (bytes > MAX_PAYLOAD_BYTES) {
    logger.error(`[realtime] message of type ${message.type} not sent: ${bytes} bytes, over ${MAX_PAYLOAD_BYTES}`);
    return false;
  }
  if (Date.now() < pausedUntil) throw unavailable('publishing paused after a failure');
  try {
    await pgPool.get().pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
  } catch (err) {
    failures += 1;
    const wait = Math.round(Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** (failures - 1)) * (0.5 + Math.random()));
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

/** Closes every socket of this account, on every server. Never throws. */
async function disconnectUser(userId) {
  if (!env.realtime.enabled || !userId) return false;
  try {
    return await send(messages.disconnect(userRoom(userId)));
  } catch (err) {
    logger.warn(`[realtime] could not end the sockets of an account: ${err.message}`);
    return false;
  }
}

/** Every server checks its sockets' sessions and rooms now. Never throws. */
async function resyncAll() {
  if (!env.realtime.enabled) return false;
  try {
    return await send(messages.serverEvent(RESYNC_EVENT));
  } catch (err) {
    logger.warn(`[realtime] could not ask the servers to check their sockets: ${err.message}`);
    return false;
  }
}

/** Forgets a pause after a failure (tests, and before the pool is ended). */
function reset() {
  failures = 0;
  pausedUntil = 0;
}

module.exports = { publish, send, disconnectUser, resyncAll, reset, messages, CHANNEL_PREFIX, CHANNEL, RESYNC_EVENT, MAX_PAYLOAD_BYTES };
