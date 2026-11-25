'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

/**
 * zimos.co visits: who the visitor is, for the console's Site visits
 * (siteAnalytics/visitorDevice.js, SITE_VISITOR_DETAILS_ENABLED; nothing below
 * is written while it is off).
 *
 * site_visits (all nullable, no default: the catalogue changes, the table is
 * not rewritten; old rows stay null and the console shows a dash)
 *   visitor_key      HMAC of the browser's random id without the day, so a
 *                    later visit from the same browser is known as returning
 *   device_model     from Client Hints or the User-Agent; "iPhone" / "iPad"
 *                    only for Apple devices (they never say which model)
 *   os_version       e.g. 14 for Android 14; null when the browser hides it
 *   browser_version  e.g. 131
 *   screen           e.g. 390x844 (CSS pixels)
 *   language         the browser's language, e.g. ar-EG
 *   signed_in        whether the dashboard said this browser was signed in
 *
 *   site_visits_visitor_key_created_idx (visitor_key, created_at), partial
 *                    The previous visit of a visitor, and its sessions on sign
 *                    in. Built CONCURRENTLY: the beacon writes all day.
 *
 * site_visitor_accounts
 *   One row per browser that signed up or signed in from a marketing link:
 *   every visit with that visitor_key (earlier and later) belongs to the
 *   account, without rewriting any visit. The latest account wins.
 *
 * Run-twice safe and without a transaction (CONCURRENTLY). Down drops the
 * table, the index and the columns (their values are lost).
 */

const INDEX = 'site_visits_visitor_key_created_idx';
const COLUMNS = ['visitor_key', 'device_model', 'os_version', 'browser_version', 'screen', 'language', 'signed_in'];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await qi.addColumn('site_visits', 'visitor_key', { type: DataTypes.STRING(64), allowNull: true });
    await qi.addColumn('site_visits', 'device_model', { type: DataTypes.STRING(40), allowNull: true });
    await qi.addColumn('site_visits', 'os_version', { type: DataTypes.STRING(20), allowNull: true });
    await qi.addColumn('site_visits', 'browser_version', { type: DataTypes.STRING(20), allowNull: true });
    await qi.addColumn('site_visits', 'screen', { type: DataTypes.STRING(11), allowNull: true });
    await qi.addColumn('site_visits', 'language', { type: DataTypes.STRING(20), allowNull: true });
    await qi.addColumn('site_visits', 'signed_in', { type: DataTypes.BOOLEAN, allowNull: true });
    await createIndexConcurrently(queryInterface, {
      name: INDEX,
      table: 'site_visits',
      definition: '(visitor_key, created_at) WHERE visitor_key IS NOT NULL',
    });

    await qi.createTable('site_visitor_accounts', {
      visitor_key: { type: DataTypes.STRING(64), primaryKey: true },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      linked_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS site_visitor_accounts_user_id_idx ON site_visitor_accounts (user_id)');
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS site_visitor_accounts');
    await dropIndexConcurrently(queryInterface, INDEX);
    for (const column of COLUMNS) await qi.removeColumn('site_visits', column);
  },
};
