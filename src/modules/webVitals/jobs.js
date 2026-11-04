'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');

const MINUTE = 60 * 1000;
const SLICE = 5000;
const SLICES_PER_RUN = 100;

/** Rows past WEB_VITALS_RETENTION_DAYS go, a bounded number per run, so no run holds a long lock while beacons write. */
async function run({ days = env.webVitals.retentionDays } = {}) {
  if (!days || days < 1) return { removed: 0 };
  let removed = 0;
  for (let i = 0; i < SLICES_PER_RUN; i += 1) {
    const [row] = await db.sequelize.query(
      `WITH gone AS (
         DELETE FROM store_web_vitals WHERE id IN (
           SELECT id FROM store_web_vitals WHERE created_at < now() - make_interval(days => :days) LIMIT ${SLICE})
         RETURNING 1)
       SELECT count(*)::int AS n FROM gone`,
      { replacements: { days }, type: db.Sequelize.QueryTypes.SELECT }
    );
    removed += row.n;
    if (row.n < SLICE) break;
  }
  if (removed) logger.info(`[web-vitals] removed ${removed} row(s) older than ${days} days`);
  return { removed };
}

const RETENTION = { name: 'web_vitals.retention', everyMs: 6 * 60 * MINUTE, handle: () => run() };

module.exports = {
  // Only while WEB_VITALS_ENABLED is on: off, the worker registers no schedule for it.
  get schedules() {
    return env.webVitals.enabled ? [RETENTION] : [];
  },
  run,
};
