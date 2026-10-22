'use strict';

const db = require('../../../db/models');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const { ensureDays } = require('../analyticsDaily');

/**
 * Raw storefront analytics older than ANALYTICS_RAW_RETENTION_DAYS (0 or
 * unset: never — what has always happened). Run by `analytics.traffic_purge`
 * (analytics/jobs.js).
 *
 * For each store with events past the cut, oldest first: its days up to the
 * cut are counted into analytics_daily first (analyticsDaily.ensureDays — the
 * overview reads those rows, so its numbers for old periods stay), then its
 * events before the cut are deleted in slices, then the sessions that ended
 * before it. The web analytics and visitors screens read raw rows, so they
 * reach back RETENTION days only. Bounded per run (STORES_PER_RUN stores,
 * SLICES_PER_STORE slices) so one run never holds a long lock; the next run
 * goes on where it stopped.
 */

const SLICE = 5000;
const SLICES_PER_STORE = 100;
const STORES_PER_RUN = 20;

const query = (sql, replacements) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });

async function deleteSliced(sql, replacements) {
  let total = 0;
  for (let i = 0; i < SLICES_PER_STORE; i += 1) {
    const [row] = await query(`WITH gone AS (${sql}) SELECT count(*)::int AS n FROM gone`, replacements);
    total += row.n;
    if (row.n < SLICE) break;
  }
  return total;
}

async function run({ days = env.analyticsRawRetentionDays } = {}) {
  if (!days || days < 1) return { enabled: false };
  const stores = await query(
    `SELECT w.id, coalesce(w.timezone, 'UTC') AS tz
       FROM workspaces w
      WHERE EXISTS (SELECT 1 FROM analytics_events e WHERE e.workspace_id = w.id AND e.created_at < now() - make_interval(days => :days))
      LIMIT ${STORES_PER_RUN}`,
    { days }
  );
  const result = { enabled: true, stores: 0, events: 0, sessions: 0 };
  for (const store of stores) {
    try {
      const [range] = await query(
        `SELECT to_char(min(e.created_at) AT TIME ZONE :tz, 'YYYY-MM-DD') AS first_day,
                to_char((now() - make_interval(days => :days)) AT TIME ZONE :tz, 'YYYY-MM-DD') AS cut_day
           FROM analytics_events e WHERE e.workspace_id = :workspaceId`,
        { workspaceId: store.id, tz: store.tz, days }
      );
      // The cut falls on the store's midnight, so no day is half counted from raw rows.
      const cut = { workspaceId: store.id, tz: store.tz, cutDay: range.cut_day };
      if (range.first_day && range.first_day < range.cut_day) await ensureDays(store.id, store.tz, range.first_day, range.cut_day);
      result.events += await deleteSliced(
        `DELETE FROM analytics_events WHERE id IN (
           SELECT id FROM analytics_events
            WHERE workspace_id = :workspaceId AND created_at < (CAST(:cutDay AS date))::timestamp AT TIME ZONE :tz
            LIMIT ${SLICE}) RETURNING 1`,
        cut
      );
      result.sessions += await deleteSliced(
        `DELETE FROM analytics_sessions WHERE (workspace_id, id) IN (
           SELECT workspace_id, id FROM analytics_sessions
            WHERE workspace_id = :workspaceId AND created_at < (CAST(:cutDay AS date))::timestamp AT TIME ZONE :tz
              AND last_seen_at < (CAST(:cutDay AS date))::timestamp AT TIME ZONE :tz
            LIMIT ${SLICE}) RETURNING 1`,
        cut
      );
      result.stores += 1;
    } catch (err) {
      logger.warn('analytics retention failed', { workspaceId: store.id, message: err.message });
    }
  }
  if (result.events || result.sessions) logger.info(`[traffic] raw analytics retention ${JSON.stringify(result)}`);
  return result;
}

module.exports = { run };
