'use strict';

const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/postgres-adapter');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const sessionGate = require('../../core/security/sessionGate');
const { verifyAccessToken } = require('../../core/security/tokens');
const { clientIpOfUpgrade } = require('../../core/middleware/clientIp');
const { userRoom } = require('./catalog');
const { roomsByUser } = require('./rooms');
const { CHANNEL_PREFIX } = require('./publisher');

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
 *    minute on this server.
 *  - The handshake: the access token from the client's `auth.token` (never
 *    the URL), checked as core/middleware/authenticate does — signature and
 *    expiry, a session that still stands (sessionGate), an active account —
 *    and at most REALTIME_MAX_CONNECTIONS_PER_USER sockets per account here.
 *  - The rooms come from the database alone (rooms.js). The client never
 *    names one, and sends nothing: any event from it ends the connection.
 *
 * Afterwards: the connection ends when its access token expires (the client
 * reconnects with a fresh one), and within SESSION_CHECK_MS of its session
 * ending. Every ROOMS_CHECK_MS the rooms are worked out again, so a removed
 * teammate, a changed role or a suspended account stops receiving.
 */

const PATH = `/api/${env.apiVersion}/realtime/socket.io`;
const MAX_MESSAGE_BYTES = 16 * 1024;
const PING_INTERVAL_MS = 25 * 1000;
const PING_TIMEOUT_MS = 20 * 1000;
const CONNECT_TIMEOUT_MS = 10 * 1000;
const SESSION_CHECK_MS = 15 * 1000;
const ROOMS_CHECK_MS = 60 * 1000;
const WINDOW_MS = 60 * 1000;
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

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) return next(refused('unauthorized'));
      let payload;
      try {
        payload = verifyAccessToken(token);
      } catch {
        return next(refused('unauthorized'));
      }
      if (!(await sessionGate.isActive(payload.sid))) return next(refused('session_ended'));
      const rooms = (await roomsByUser([payload.sub])).get(payload.sub);
      if (!rooms) return next(refused('unauthorized'));
      const open = io.of('/').adapter.rooms.get(userRoom(payload.sub));
      if (open && open.size >= env.realtime.maxConnectionsPerUser) return next(refused('too_many_connections'));
      socket.data.userId = payload.sub;
      socket.data.sid = payload.sid || null;
      socket.data.expiresAt = payload.exp ? payload.exp * 1000 : null;
      socket.data.rooms = rooms;
      return next();
    } catch (err) {
      logger.warn(`[realtime] handshake failed: ${err.message}`);
      return next(refused('unavailable'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(socket.data.rooms);
    // Nothing comes from the client but the built-in ping: any event of its own ends the connection.
    socket.onAny(() => socket.disconnect(true));
    if (socket.data.expiresAt) {
      const timer = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.expiresAt - Date.now()));
      socket.on('disconnect', () => clearTimeout(timer));
    }
  });

  const localSockets = () => [...io.of('/').sockets.values()];

  /** Ends the connections whose token has expired or whose session has ended. */
  async function checkSessions() {
    for (const socket of localSockets()) {
      if (socket.data.expiresAt && socket.data.expiresAt <= Date.now()) {
        socket.disconnect(true);
        continue;
      }
      try {
        if (!(await sessionGate.isActive(socket.data.sid))) socket.disconnect(true);
      } catch {
        /* the next check asks again */
      }
    }
  }

  /** Works every connection's rooms out again; an account that may no longer connect is let go. */
  async function syncRooms() {
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

  return { io, stop, checkSessions, syncRooms, resetLimits: limiter.reset };
}

module.exports = { createRealtimeServer, PATH, SESSION_CHECK_MS, ROOMS_CHECK_MS };
