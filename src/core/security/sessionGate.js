'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');

/**
 * Ending a session cuts access at once: ending one device, ending
 * all of them, a password reset, a replayed refresh token. Revoking a session
 * already stopped its refresh token; the access token it had handed out kept
 * working until it expired (JWT_ACCESS_EXPIRES_IN, 15 minutes). Now the
 * access token names its session (`sid`), and every authenticated request
 * checks that session still stands.
 *
 * A refresh replaces the session row (authService.refresh): the old row is
 * revoked and points at the new one (`rotated_to_session_id`). An access token
 * from before the refresh is still good while that chain ends in a live
 * session — a request in flight during a refresh must not log the person out.
 * A revoked session has no successor, so the chain ends there.
 *
 * The answer is kept for CACHE_MS, so a busy dashboard does not ask the
 * database on every request. Any change to a session on this server empties
 * the cache (the hooks below), so here the cut is immediate. Another server
 * learns within CACHE_MS. A token without `sid`, issued before this change,
 * is let through until it expires.
 */

const CACHE_MS = 10 * 1000;
const CACHE_MAX = 10000;
const MAX_CHAIN = 50;
const cache = new Map();

const CHAIN_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, revoked_at, expires_at, rotated_to_session_id, 1 AS depth FROM sessions WHERE id = $sid
    UNION ALL
    SELECT s.id, s.revoked_at, s.expires_at, s.rotated_to_session_id, c.depth + 1
      FROM sessions s JOIN chain c ON s.id = c.rotated_to_session_id
     WHERE c.revoked_at IS NOT NULL AND c.depth < ${MAX_CHAIN}
  )
  SELECT id, (revoked_at IS NULL AND expires_at > now()) AS active FROM chain ORDER BY depth DESC LIMIT 1`;

async function isActive(sid) {
  if (!sid) return true;
  const hit = cache.get(sid);
  if (hit && hit.until > Date.now()) return hit.active;
  const [row] = await db.sequelize.query(CHAIN_SQL, { bind: { sid }, type: QueryTypes.SELECT });
  const active = Boolean(row && row.active);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(sid, { active, until: Date.now() + CACHE_MS });
  return active;
}

/**
 * The session an access token's `sid` stands for now: the live end of its
 * refresh chain. Null for a token without one, or whose chain has ended.
 * Read from the database each time: it decides which session a change spares
 * (authService.endOtherSessions).
 */
async function currentSessionId(sid) {
  if (!sid) return null;
  const [row] = await db.sequelize.query(CHAIN_SQL, { bind: { sid }, type: QueryTypes.SELECT });
  return row && row.active ? row.id : null;
}

function forgetAll() {
  cache.clear();
}

// Every way a session ends goes through an update of its row (or rows).
db.Session.addHook('afterUpdate', 'sessionGate', forgetAll);
db.Session.addHook('afterBulkUpdate', 'sessionGate', forgetAll);
db.Session.addHook('afterDestroy', 'sessionGate', forgetAll);
db.Session.addHook('afterBulkDestroy', 'sessionGate', forgetAll);

const STREAM_CHECK_MS = 15 * 1000;

/**
 * For a response held open (the inbox and live-analytics streams): ends it
 * once the session it was opened under ends.
 */
function closeWhenEnded(req, res, sid) {
  if (!sid) return;
  const timer = setInterval(async () => {
    try {
      if (!(await isActive(sid))) {
        clearInterval(timer);
        res.end();
      }
    } catch {
      /* the next tick asks again */
    }
  }, STREAM_CHECK_MS);
  req.on('close', () => clearInterval(timer));
}

module.exports = { isActive, currentSessionId, forgetAll, closeWhenEnded, CACHE_MS };
