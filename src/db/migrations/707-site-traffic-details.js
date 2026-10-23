'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * zimos.co visits with the same detail as a store's
 * (siteAnalytics/siteTrafficDetails.js, SITE_TRAFFIC_DETAILS_ENABLED; nothing
 * below is written while it is off).
 *
 * site_visits
 *   browser     the browser's family (clientDetect), like a store visit's
 *   governorate one of the 27 codes, from Cloudflare's region header only
 *               (ANALYTICS_GEO_HEADERS), null without it
 *   cta_kind    register | login: which dashboard link a cta_click was
 *
 * traffic_filter_days
 *   scope       store (every row so far) | site: what the guard kept out of
 *               the marketing site is counted with the same counters
 *               (analytics/traffic/trafficCounters.js). Its unique key now
 *               includes the scope: the new index is built before the old
 *               one is dropped, both CONCURRENTLY.
 *
 * Run-twice safe and without a transaction (CONCURRENTLY). Down deletes the
 * site's counts first (the old key cannot hold a store row and a site row
 * with the same day, reason and label), then puts the old key back.
 */

const OLD_KEY = 'traffic_filter_days_key_uq';
const NEW_KEY = 'traffic_filter_days_scope_key_uq';
const NO_STORE = "(coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))";

async function constraintExists(queryInterface, name) {
  const [rows] = await queryInterface.sequelize.query('SELECT 1 FROM pg_constraint WHERE conname = :name', { replacements: { name } });
  return rows.length > 0;
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await qi.addColumn('site_visits', 'browser', { type: DataTypes.STRING(20), allowNull: true });
    await qi.addColumn('site_visits', 'governorate', { type: DataTypes.STRING(30), allowNull: true });
    await qi.addColumn('site_visits', 'cta_kind', { type: DataTypes.STRING(10), allowNull: true });
    if (!(await constraintExists(queryInterface, 'site_visits_cta_kind_check'))) {
      await queryInterface.sequelize.query(
        "ALTER TABLE site_visits ADD CONSTRAINT site_visits_cta_kind_check CHECK (cta_kind IS NULL OR cta_kind IN ('register', 'login'))"
      );
    }

    await qi.addColumn('traffic_filter_days', 'scope', { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'store' });
    if (!(await constraintExists(queryInterface, 'traffic_filter_days_scope_check'))) {
      await queryInterface.sequelize.query("ALTER TABLE traffic_filter_days ADD CONSTRAINT traffic_filter_days_scope_check CHECK (scope IN ('store', 'site'))");
    }
    await createIndexConcurrently(queryInterface, {
      name: NEW_KEY,
      table: 'traffic_filter_days',
      definition: `(day, scope, kind, reason, label, country, ${NO_STORE})`,
      unique: true,
    });
    await dropIndexConcurrently(queryInterface, OLD_KEY);
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    const [[scope]] = await queryInterface.sequelize.query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'traffic_filter_days' AND column_name = 'scope'"
    );
    if (scope.n > 0) await queryInterface.sequelize.query("DELETE FROM traffic_filter_days WHERE scope = 'site'");
    await createIndexConcurrently(queryInterface, {
      name: OLD_KEY,
      table: 'traffic_filter_days',
      definition: `(day, kind, reason, label, country, ${NO_STORE})`,
      unique: true,
    });
    await dropIndexConcurrently(queryInterface, NEW_KEY);
    await queryInterface.sequelize.query('ALTER TABLE traffic_filter_days DROP CONSTRAINT IF EXISTS traffic_filter_days_scope_check');
    await qi.removeColumn('traffic_filter_days', 'scope');

    await queryInterface.sequelize.query('ALTER TABLE site_visits DROP CONSTRAINT IF EXISTS site_visits_cta_kind_check');
    for (const column of ['cta_kind', 'governorate', 'browser']) await qi.removeColumn('site_visits', column);
  },
};
