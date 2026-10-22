'use strict';

const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');
const { LIMITS } = require('./guardConfig');

/**
 * Deletes what the events guard keeps only for a while (analytics/jobs.js,
 * `analytics.traffic_purge`): quarantined events after LIMITS.QUARANTINE_DAYS,
 * the daily counts of what was kept out after LIMITS.FILTER_DAYS, the per-store
 * daily totals after 90 days, and each day's IP salt after
 * LIMITS.SALT_KEEP_DAYS — once a salt is gone, no stored ip_hash can be tied
 * back to an address. Only these guard tables; never a store's analytics.
 * Deletes in slices so one run never holds a long lock.
 */

const SLICE = 5000;
const MAX_SLICES = 200;

async function sliced(sql, replacements) {
  let total = 0;
  for (let i = 0; i < MAX_SLICES; i += 1) {
    const rows = await db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });
    total += rows.length;
    if (rows.length < SLICE) break;
  }
  return total;
}

async function run() {
  const quarantined = await sliced(
    `DELETE FROM analytics_quarantine_events WHERE id IN (
       SELECT id FROM analytics_quarantine_events WHERE quarantined_at < NOW() - make_interval(days => :days) LIMIT ${SLICE}
     ) RETURNING id`,
    { days: LIMITS.QUARANTINE_DAYS }
  );
  const count = async (sql, replacements = {}) => {
    const [row] = await db.sequelize.query(`WITH gone AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM gone`, {
      replacements,
      type: db.Sequelize.QueryTypes.SELECT,
    });
    return row.n;
  };
  // The guard's days are UTC days (trafficCounters, ipHash).
  const today = "(now() AT TIME ZONE 'UTC')::date";
  const result = {
    quarantined,
    filterDays: await count(`DELETE FROM traffic_filter_days WHERE day < ${today} - CAST(:days AS integer)`, { days: LIMITS.FILTER_DAYS }),
    storeDays: await count(`DELETE FROM traffic_store_days WHERE day < ${today} - 90`),
    salts: await count(`DELETE FROM traffic_salts WHERE day < ${today} - CAST(:days AS integer)`, { days: LIMITS.SALT_KEEP_DAYS }),
  };
  if (Object.values(result).some(Boolean)) logger.info(`[traffic] purged ${JSON.stringify(result)}`);
  return result;
}

module.exports = { run };
