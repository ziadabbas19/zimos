'use strict';

const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/postgres-adapter');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const sessionGate = require('../../core/security/sessionGate');
const { verifyAccessToken } = require('../../core/security/tokens');
const { clientIpOfUpgrade } = require('../../core/middleware/clientIp');
const { roomsByUser } = require('./rooms');
const { CHANNEL_PREFIX, RESYNC_EVENT } = require('./publisher');
// The model hooks that end an account's sockets as soon as its access changes.
require('./control');

/**
 * The Socket.IO server of the live updates, on the API's own HTTP server.
 *
 * Websocket only: Railway has no sticky sessions, and long polling needs them
 * once there is more than one API process. The postgres adapter carries a
 * message from the process that publishes it (publisher.js) to every
 * process's sockets.
 *
 * Who gets in, and into which rooms:
 *  - Before the upgrade (allowRequest): a browser's Origin must be one of
 *    CORS_ORIGINS, and one IP may try REALTIME_HANDSHAKES_PER_MINUTE times a
 *    minute on this server. Counted in this process's memory, so with N API
 *    processes an IP gets N times as many; a limit against one noisy client,
 *    not against many addresses.
 *  - The handshake: the access token from the client's `auth.token` (never
 *    the URL), checked as core/middleware/authenticate does — signature and
 *    expiry, a session that still stands (sessionGate), an active account.
 *    Right after the signature, before any database query, the account takes
 *    one of its REALTIME_MAX_CONNECTIONS_PER_USER places on this server (open
 *    sockets and handshakes in progress alike), given back when the websocket
 *    closes. One websocket runs one handshake at a time, at most
 *    CONNECTS_PER_SOCKET_PER_MINUTE a minute, and none once a socket is open
 *    on it. Any refusal closes the websocket.
 *  - The rooms come from the database alone (rooms.js). The client never
 *    names one, and sends nothing: any event from it ends the connection.
 *
 * Afterwards: the connection ends when its access token expires (the client
 * reconnects with a fresh one). When the account's access changes — removed
 * or given another role in a store, a session ended, suspended — its sockets
 * are closed on every server as soon as the change commits (control.js), and
 * the next handshake sees the change: the session is read from the database
 * there, not from sessionGate's 10-second cache. As a safety net, sessions are
 * checked every SESSION_CHECK_MS and rooms every ROOMS_CHECK_MS.
 */

const PATH = `/api/${env.apiVersion}/realtime/socket.io`;
const MAX_MESSAGE_BYTES = 16 * 1024;
const PING_INTERVAL_MS = 25 * 1000;
const PING_TIMEOUT_MS = 20 * 1000;
const CONNECT_TIMEOUT_MS = 10 * 1000;
const SESSION_CHECK_MS = 15 * 1000;
const ROOMS_CHECK_MS = 60 * 1000;
const WINDOW_MS = 60 * 1000;
const CONNECTS_PER_SOCKET_PER_MINUTE = 5;
const ATTEMPTS = Symbol('realtime handshake attempts');
const MAX_TRACKED_IPS = 10000;

const MAX_TOKEN_LENGTH = 4096;
// The adapter's table for messages too big for a NOTIFY (migration 708). Ours never are (publisher.js).
const ATTACHMENTS_TABLE = 'socket_io_attachments';

/** A refused handshake: the client's connect_error carries `code` and nothing else. */
function refused(code) {
  const err = new Error(code);
  err.data = { code };
  return err;
}

/** Whether the token's session still stands, read from the database every time (no cache). A token without one, from before sessions were named, passes as in sessionGate. */
async function sessionStands(sid) {
  if (!sid) return true;
  return Boolean(await sessionGate.currentSessionId(sid));
}

/** Calls `fn` the first time only. */
function once(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** Each account's places on this server: open sockets and handshakes in progress. */
function connectionSlots() {
  const taken = new Map();
  return {
    take(userId) {
      const n = taken.get(userId) || 0;
      if (n >= env.realtime.maxConnectionsPerUser) return false;
      taken.set(userId, n + 1);
      return true;
    },
    give(userId) {
      const n = (taken.get(userId) || 0) - 1;
      if (n > 0) taken.set(userId, n);
      else taken.delete(userId);
    },
    held: (userId) => taken.get(userId) || 0,
  };
}

/** Connection attempts per IP, per fixed minute, on this server. */
function handshakeLimiter() {
  const counts = new Map();
  return {
    allow(ip) {
      const now = Date.now();
      const key = ip || 'unknown';
      let entry = counts.get(key);
      if (!entry || entry.resetAt <= now) {
        if (counts.size >= MAX_TRACKED_IPS) {
          for (const [k, v] of counts) if (v.resetAt <= now) counts.delete(k);
          if (counts.size >= MAX_TRACKED_IPS) counts.delete(counts.keys().next().value);
        }
        entry = { count: 0, resetAt: now + WINDOW_MS };
        counts.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= env.realtime.handshakesPerMinute;
    },
    reset() {
      counts.clear();
    },
  };
}

/** A warning at most every `everyMs`, saying how many were left out: a database that is down fails every few seconds. */
function throttledWarn(prefix, everyMs = 30 * 1000) {
  let last = 0;
  let skipped = 0;
  return (err) => {
    const now = Date.now();
    if (now - last < everyMs) {
      skipped += 1;
      return;
    }
    last = now;
    logger.warn(`${prefix}: ${err && err.message}${skipped ? ` (and ${skipped} more since the last warning)` : ''}`);
    skipped = 0;
  };
}

/**
 * Starts the socket server on `httpServer`. `app` is the Express app, whose
 * `trust proxy` reads the client IP; `connections` the database connections
 * of the adapter (pgPool.createConnections: its LISTEN client is its own).
 */
function createRealtimeServer(httpServer, { app, connections }) {
  const limiter = handshakeLimiter();
  const slots = connectionSlots();

  const allowRequest = (req, callback) => {
    const origin = req.headers.origin;
    if (origin && !env.cors.origins.includes(origin)) return callback('origin not allowed', false);
    if (!limiter.allow(clientIpOfUpgrade(req, app))) return callback('too many connection attempts', false);
    return callback(null, true);
  };

  const io = new Server(httpServer, {
    path: PATH,
    transports: ['websocket'],
    serveClient: false,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    pingInterval: PING_INTERVAL_MS,
    pingTimeout: PING_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    allowRequest,
    adapter: createAdapter(connections.forAdapter, {
      channelPrefix: CHANNEL_PREFIX,
      tableName: ATTACHMENTS_TABLE,
      errorHandler: throttledWarn('[realtime] adapter'),
    }),
  });

  // Ends the websocket under a refused handshake, once the refusal is on its way.
  const closeAfter = (socket) => setImmediate(() => socket.conn.close());

  io.use(async (socket, next) => {
    const { conn } = socket;
    const now = Date.now();
    const attempts = conn[ATTEMPTS] || (conn[ATTEMPTS] = { count: 0, since: now, busy: false });
    if (now - attempts.since >= WINDOW_MS) {
      attempts.count = 0;
      attempts.since = now;
    }
    attempts.count += 1;
    const refuse = (code) => {
      closeAfter(socket);
      return next(refused(code));
    };
    // CONNECT packets sent together on one websocket: the first is handled, the rest end it.
    if (attempts.busy || attempts.count > CONNECTS_PER_SOCKET_PER_MINUTE || socket.client.sockets.size > 0) return refuse('too_many_attempts');

    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) return refuse('unauthorized');
    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      return refuse('unauthorized');
    }
    // Nothing that signs in stays on the socket: the adapter answers a FETCH_SOCKETS request, which
    // anyone connected to the database can send, with every socket's handshake.
    socket.handshake.auth = {};
    delete socket.handshake.headers.cookie;
    delete socket.handshake.headers.authorization;
    // The account's place, taken before anything asks the database.
    const userId = payload.sub;
    if (!userId || !slots.take(userId)) return refuse('too_many_connections');
    const giveBack = once(() => slots.give(userId));
    conn.once('close', giveBack);

    attempts.busy = true;
    try {
      if (!(await sessionStands(payload.sid))) {
        giveBack();
        return refuse('session_ended');
      }
      const rooms = (await roomsByUser([userId])).get(userId);
      if (!rooms) {
        giveBack();
        return refuse('unauthorized');
      }
      socket.data.userId = userId;
      socket.data.sid = payload.sid || null;
      socket.data.expiresAt = payload.exp ? payload.exp * 1000 : null;
      socket.data.rooms = rooms;
      socket.data.giveBack = giveBack;
      return next();
    } catch (err) {
      logger.warn(`[realtime] handshake failed: ${err.message}`);
      giveBack();
      return refuse('unavailable');
    } finally {
      attempts.busy = false;
    }
  });

  io.on('connection', (socket) => {
    socket.join(socket.data.rooms);
    socket.once('disconnect', socket.data.giveBack);
    // Nothing comes from the client but the built-in ping: any event of its own ends the connection.
    socket.onAny(() => socket.disconnect(true));
    if (socket.data.expiresAt) {
      const timer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
      socket.on('disconnect', () => clearTimeout(timer));
    }
  });

  const localSockets = () => [...io.of('/').sockets.values()];

  // A check still running when the next is due lets it pass: they never stack up.
  const running = { sessions: false, rooms: false };

  /** Ends the connections whose token has expired or whose session has ended; `fresh` reads every session from the database. */
  async function checkSessions({ fresh = false } = {}) {
    if (running.sessions) return;
    running.sessions = true;
    try {
      await checkEachSession(fresh);
    } finally {
      running.sessions = false;
    }
  }

  async function checkEachSession(fresh) {
    for (const socket of localSockets()) {
      if (socket.data.expiresAt && socket.data.expiresAt <= Date.now()) {
        socket.disconnect(true);
        continue;
      }
      try {
        const stands = fresh ? await sessionStands(socket.data.sid) : await sessionGate.isActive(socket.data.sid);
        if (!stands) socket.disconnect(true);
      } catch {
        /* the next check asks again */
      }
    }
  }

  /** Works every connection's rooms out again; an account that may no longer connect is let go. */
  async function syncRooms() {
    if (running.rooms) return;
    running.rooms = true;
    try {
      await syncEachRoom();
    } finally {
      running.rooms = false;
    }
  }

  async function syncEachRoom() {
    const sockets = localSockets();
    if (sockets.length === 0) return;
    let byUser;
    try {
      byUser = await roomsByUser(sockets.map((s) => s.data.userId));
    } catch (err) {
      logger.warn(`[realtime] rooms check failed: ${err.message}`);
      return;
    }
    for (const socket of sockets) {
      const rooms = byUser.get(socket.data.userId);
      if (!rooms) {
        socket.disconnect(true);
        continue;
      }
      for (const room of socket.rooms) if (room !== socket.id && !rooms.includes(room)) socket.leave(room);
      socket.join(rooms);
      socket.data.rooms = rooms;
    }
  }

  // A change that did not say whose access it touched (control.js): every server checks everything now.
  io.of('/').on(RESYNC_EVENT, () => {
    void checkSessions({ fresh: true });
    void syncRooms();
  });

  const sessionTimer = setInterval(() => void checkSessions(), SESSION_CHECK_MS);
  const roomsTimer = setInterval(() => void syncRooms(), ROOMS_CHECK_MS);
  sessionTimer.unref();
  roomsTimer.unref();

  /** Closes every connection and the adapter. The HTTP server is left to its owner. */
  async function stop() {
    clearInterval(sessionTimer);
    clearInterval(roomsTimer);
    io.local.disconnectSockets(true);
    await io.of('/').adapter.close();
    io.engine.close();
  }

  return { io, stop, checkSessions, syncRooms, resetLimits: limiter.reset, slotsHeld: slots.held };
}

module.exports = { createRealtimeServer, PATH, SESSION_CHECK_MS, ROOMS_CHECK_MS, CONNECTS_PER_SOCKET_PER_MINUTE };
