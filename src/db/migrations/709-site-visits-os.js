'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * zimos.co visits: the operating system, and an index for the console's Live
 * view (siteAnalytics/siteTrafficLive.js).
 *
 * site_visits
 *   os   the operating system's family (analytics/clientDetect), like the
 *        browser; written only while SITE_LIVE_ENABLED is on, null before and
 *        without it. Not personal data: the same family thousands
 *        of visitors share. Nullable with no default, so adding it changes
 *        the catalogue only and does not rewrite the table.
 *
 *   site_visits_session_created_idx (session_id, created_at)
 *        The Live view asks, every 15 seconds, for each session seen in the
 *        last five minutes: its first view, its latest page and its latest
 *        CTA. With session_id alone each of those reads every row of the
 *        session (a tab open for hours pings every 15 seconds) and sorts
 *        them; with created_at after it, each is one index step. Built
 *        CONCURRENTLY: the table takes the beacon's writes all day.
 *
 * Run-twice safe and without a transaction (CONCURRENTLY). Down drops the
 * index, then the column (its values are lost; nothing else reads them).
 */

const INDEX = 'site_visits_session_created_idx';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    await qi.addColumn('site_visits', 'os', { type: Sequelize.DataTypes.STRING(20), allowNull: true });
    await createIndexConcurrently(queryInterface, { name: INDEX, table: 'site_visits', definition: '(session_id, created_at)' });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await dropIndexConcurrently(queryInterface, INDEX);
    await qi.removeColumn('site_visits', 'os');
  },
};
