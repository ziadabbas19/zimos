'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');

/**
 * zimos.co visits older than SITE_VISITS_RETENTION_DAYS are deleted (0 or
 * unset: never — what has always happened). Run by
 * `site_analytics.visits_retention` (jobs.js).
 *
 * Deleted in slices through site_visits_created_at_idx, a bounded number per
 * run, so one run never holds a long lock while the beacon writes; the next
 * run goes on where it stopped. The accounts' first visits are copies in
 * user_acquisition, which is not touched: it lasts as long as the account.
 */

const SLICE = 5000;
const SLICES_PER_RUN = 100;

async function run({ days = env.siteVisitsRetentionDays } = {}) {
  if (!days || days < 1) return { enabled: false };
  let removed = 0;
  for (let i = 0; i < SLICES_PER_RUN; i += 1) {
    const [row] = await db.sequelize.query(
      `WITH gone AS (
         DELETE FROM site_visits WHERE id IN (
           SELECT id FROM site_visits WHERE created_at < now() - make_interval(days => :days) LIMIT ${SLICE})
         RETURNING 1)
       SELECT count(*)::int AS n FROM gone`,
      { replacements: { days }, type: db.Sequelize.QueryTypes.SELECT }
    );
    removed += row.n;
    if (row.n < SLICE) break;
  }
  if (removed) logger.info(`[site-analytics] removed ${removed} visit row(s) older than ${days} days`);
  return { enabled: true, removed };
}

module.exports = { run };
