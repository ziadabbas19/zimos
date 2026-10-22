'use strict';

const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const { LIMITS } = require('./guardConfig');
const { createWindowCounter } = require('./windowCounter');
const counters = require('./trafficCounters');

/**
 * Traffic no person makes, and keeping it out of the numbers.
 *
 *  - Duplicates: the same visitor, event name and page within
 *    LIMITS.DEDUPE_MS counts once (a double-fired tracker, a replayed batch).
 *  - Too fast: more than LIMITS.PAGES_PER_MINUTE page views by one visitor in
 *    a minute.
 *  - Impossible visible time: reported by the dwell update
 *    (visitorDetails.js) through flagSession.
 *  - Automation: the browser says it is driven by WebDriver (the tracker
 *    sends navigator.webdriver); the session is marked is_bot.
 *
 * A flagged session's events move from analytics_events to
 * analytics_quarantine_events in one statement, so every existing report
 * stops counting them at once; later events of the session are only counted
 * (analytics_sessions.excluded_events and traffic_filter_days). A session
 * that holds a real order is never flagged: an order is a person.
 *
 * The duplicate and per-minute counts live in this process's memory.
 */

const pageViews = createWindowCounter({ windowMs: LIMITS.WINDOW_MS });
const lastSeen = new Map();
const LAST_SEEN_MAX = 200000;

function pruneLastSeen(nowMs) {
  if (lastSeen.size <= LAST_SEEN_MAX) return;
  for (const [key, at] of lastSeen) {
    if (Math.abs(nowMs - at) > 5 * LIMITS.DEDUPE_MS) lastSeen.delete(key);
  }
  if (lastSeen.size > LAST_SEEN_MAX) lastSeen.clear();
}

/** True when the same event of the same visitor on the same page was seen within LIMITS.DEDUPE_MS of `atMs`. */
function isDuplicate({ workspaceId, visitorId, name, page }, atMs) {
  const key = `${workspaceId}|${visitorId}|${name}|${page || ''}`;
  const last = lastSeen.get(key);
  lastSeen.set(key, atMs);
  pruneLastSeen(Date.now());
  return last !== undefined && Math.abs(atMs - last) < LIMITS.DEDUPE_MS;
}

/** Adds `n` page views of the visitor to this minute; true when that takes them past LIMITS.PAGES_PER_MINUTE. */
function tooFast(workspaceId, visitorId, n) {
  if (!n) return false;
  return pageViews.add(`${workspaceId}|${visitorId}`, n) > LIMITS.PAGES_PER_MINUTE;
}

// The columns analytics_events and analytics_quarantine_events share, read once.
let sharedColumns = null;
async function quarantineColumns() {
  if (sharedColumns) return sharedColumns;
  const rows = await db.sequelize.query(
    `SELECT e.column_name AS name
       FROM information_schema.columns e
       JOIN information_schema.columns q
         ON q.table_schema = e.table_schema AND q.table_name = 'analytics_quarantine_events' AND q.column_name = e.column_name
      WHERE e.table_schema = current_schema() AND e.table_name = 'analytics_events'
      ORDER BY e.ordinal_position`,
    { type: db.Sequelize.QueryTypes.SELECT }
  );
  sharedColumns = rows.map((r) => `"${r.name}"`).join(', ');
  return sharedColumns;
}

/**
 * Flags the session (once) and moves its events out of the numbers. `reason`
 * is automation | too_fast | impossible_dwell. Returns true when this call
 * flagged it. Never throws: a failure is logged and the session stays as it was.
 */
async function flagSession(workspaceId, sessionId, reason, { country = '' } = {}) {
  const isBot = reason === 'automation';
  try {
    const moved = await db.sequelize.transaction(async (transaction) => {
      const flagged = await db.sequelize.query(
        `UPDATE analytics_sessions s
            SET is_bot = s.is_bot OR :isBot, is_suspicious = s.is_suspicious OR NOT :isBot,
                flag_reason = :reason, flagged_at = NOW()
          WHERE s.workspace_id = :workspaceId AND s.id = :sessionId
            AND NOT s.is_bot AND NOT s.is_suspicious
            AND NOT EXISTS (SELECT 1 FROM analytics_events e
                             WHERE e.workspace_id = :workspaceId AND e.session_id = :sessionId
                               AND e.event_name = 'purchase' AND e.order_id IS NOT NULL)
          RETURNING s.id`,
        { replacements: { workspaceId, sessionId, reason, isBot }, type: db.Sequelize.QueryTypes.SELECT, transaction }
      );
      if (flagged.length === 0) return null;
      const columns = await quarantineColumns();
      const rows = await db.sequelize.query(
        `WITH moved AS (
           DELETE FROM analytics_events WHERE workspace_id = :workspaceId AND session_id = :sessionId RETURNING ${columns}
         )
         INSERT INTO analytics_quarantine_events (${columns}, reason, quarantined_at)
         SELECT ${columns}, :reason, NOW() FROM moved
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        { replacements: { workspaceId, sessionId, reason }, type: db.Sequelize.QueryTypes.SELECT, transaction }
      );
      await db.sequelize.query(
        'UPDATE analytics_sessions SET excluded_events = excluded_events + :n WHERE workspace_id = :workspaceId AND id = :sessionId',
        { replacements: { workspaceId, sessionId, n: rows.length }, transaction }
      );
      return rows.length;
    });
    if (moved === null) return false;
    counters.recordFiltered({ workspaceId, kind: isBot ? 'bot' : 'suspicious', reason, country, count: Math.max(1, moved) });
    return true;
  } catch (err) {
    logger.warn(`[traffic] session not flagged (${reason}): ${err.message}`);
    return false;
  }
}

/** Events of an already flagged session: counted on the session and per day, never stored. */
async function countExcluded(workspaceId, sessionId, { reason, isBot, count, country = '' }) {
  if (!count) return;
  counters.recordFiltered({ workspaceId, kind: isBot ? 'bot' : 'suspicious', reason: reason || 'flagged', country, count });
  try {
    await db.sequelize.query(
      'UPDATE analytics_sessions SET excluded_events = excluded_events + :n, last_seen_at = NOW() WHERE workspace_id = :workspaceId AND id = :sessionId',
      { replacements: { workspaceId, sessionId, n: count } }
    );
  } catch (err) {
    logger.warn(`[traffic] excluded events not counted: ${err.message}`);
  }
}

/** Tests: forget the in-memory counts. */
function reset() {
  pageViews.clear();
  lastSeen.clear();
}

module.exports = { isDuplicate, tooFast, flagSession, countExcluded, reset };
