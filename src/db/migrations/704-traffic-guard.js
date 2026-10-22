'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The guard on the storefront events endpoint (modules/analytics/traffic,
 * TRAFFIC_GUARD_ENABLED). Nothing here is written while the flag is off.
 *
 * analytics_sessions
 *   ip_hash          the visitor's IP hashed with that UTC day's random salt
 *                    (traffic_salts), 16 hex characters; never the IP itself
 *   is_bot           the browser said it is driven by automation (navigator.webdriver)
 *   is_suspicious    behaviour no person has (too many pages a minute, a
 *                    visible time longer than the visit)
 *   flag_reason      automation | too_fast | impossible_dwell
 *   flagged_at       when it was flagged
 *   excluded_events  events of this session kept out of the numbers
 *   A flagged session's events leave analytics_events for
 *   analytics_quarantine_events, so every existing report stops counting them.
 *
 * analytics_quarantine_events   those events, for review; purged after 14 days
 * traffic_filter_days           what the guard kept out, counted per day,
 *                               store, kind, reason, label (bot family, …)
 *                               and country; purged after 30 days
 * traffic_store_days            raw events stored per store and UTC day, and
 *                               what went over the daily cap (counted only)
 * traffic_salts                 one random salt per UTC day for ip_hash;
 *                               deleted two days later, so old hashes cannot
 *                               be recomputed from an IP
 * platform_notifications.type   + 'traffic_cap' (a store went over its cap)
 *
 * Additive and run-twice safe, and run without a transaction (sequelize-cli
 * runs a file as it is): the columns on analytics_sessions are added with
 * constant defaults (no table rewrite), and its one new index — partial, on
 * the flagged rows only — is built CONCURRENTLY. The new tables are empty.
 */

const FLAG_REASONS = ['automation', 'too_fast', 'impossible_dwell'];
const FILTER_KINDS = ['bot', 'rejected', 'suspicious', 'capped'];
const NOTIFICATION_CHECKS = [
  ['platform_notifications', 'platform_notifications_type_check'],
  ['platform_notification_prefs', 'platform_notification_prefs_type_check'],
];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

async function constraintExists(queryInterface, name) {
  const [rows] = await queryInterface.sequelize.query('SELECT 1 FROM pg_constraint WHERE conname = :name', { replacements: { name } });
  return rows.length > 0;
}

async function notificationTypes(queryInterface, name) {
  const [rows] = await queryInterface.sequelize.query('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = :name', {
    replacements: { name },
  });
  if (rows.length === 0) return null;
  return [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

async function setNotificationTypes(queryInterface, change, { notValid = false } = {}) {
  for (const [table, name] of NOTIFICATION_CHECKS) {
    const current = await notificationTypes(queryInterface, name);
    if (!current) continue;
    const next = change(current);
    if (next.length === current.length && next.every((t) => current.includes(t))) continue;
    await queryInterface.sequelize.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`);
    await queryInterface.sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (type IN (${list(next)}))${notValid ? ' NOT VALID' : ''}`);
  }
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const now = { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') };

    await qi.addColumn('analytics_sessions', 'ip_hash', { type: DataTypes.STRING(16), allowNull: true });
    await qi.addColumn('analytics_sessions', 'is_bot', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await qi.addColumn('analytics_sessions', 'is_suspicious', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    await qi.addColumn('analytics_sessions', 'flag_reason', { type: DataTypes.STRING(30), allowNull: true });
    await qi.addColumn('analytics_sessions', 'flagged_at', { type: DataTypes.DATE, allowNull: true });
    await qi.addColumn('analytics_sessions', 'excluded_events', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
    if (!(await constraintExists(queryInterface, 'analytics_sessions_flag_reason_check'))) {
      await queryInterface.sequelize.query(
        `ALTER TABLE analytics_sessions ADD CONSTRAINT analytics_sessions_flag_reason_check CHECK (flag_reason IS NULL OR flag_reason IN (${list(FLAG_REASONS)}))`
      );
    }
    // The console's list of flagged sessions reads only these few rows. Built
    // CONCURRENTLY (an existing table, outside a transaction: migrationGuards).
    await qi.addIndex('analytics_sessions', ['flagged_at'], {
      name: 'analytics_sessions_flagged_at_idx',
      where: { flagged_at: { [Sequelize.Op.ne]: null } },
    });

    // The same columns as analytics_events (whole rows move here and, on the
    // way down, back), plus why and when. No foreign keys but the store's.
    const [[quarantine]] = await queryInterface.sequelize.query("SELECT to_regclass('public.analytics_quarantine_events') AS oid");
    if (!quarantine.oid) {
      await queryInterface.sequelize.query('CREATE TABLE analytics_quarantine_events (LIKE analytics_events INCLUDING DEFAULTS)');
      await queryInterface.sequelize.query('ALTER TABLE analytics_quarantine_events ADD PRIMARY KEY (id)');
      await queryInterface.sequelize.query(
        `ALTER TABLE analytics_quarantine_events
           ADD COLUMN reason VARCHAR(30) NOT NULL DEFAULT 'too_fast',
           ADD COLUMN quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           ADD CONSTRAINT analytics_quarantine_events_workspace_id_fkey
             FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE`
      );
    }
    await qi.addIndex('analytics_quarantine_events', ['workspace_id', 'session_id', 'created_at'], { name: 'analytics_quarantine_events_ws_session_idx' });
    await qi.addIndex('analytics_quarantine_events', ['quarantined_at'], { name: 'analytics_quarantine_events_quarantined_at_idx' });

    await qi.createTable('traffic_filter_days', {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      day: { type: DataTypes.DATEONLY, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      kind: { type: DataTypes.STRING(20), allowNull: false },
      reason: { type: DataTypes.STRING(30), allowNull: false },
      label: { type: DataTypes.STRING(100), allowNull: false, defaultValue: '' },
      country: { type: DataTypes.STRING(2), allowNull: false, defaultValue: '' },
      count: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      updated_at: now,
    });
    if (!(await constraintExists(queryInterface, 'traffic_filter_days_kind_check'))) {
      await queryInterface.sequelize.query(`ALTER TABLE traffic_filter_days ADD CONSTRAINT traffic_filter_days_kind_check CHECK (kind IN (${list(FILTER_KINDS)}))`);
    }
    // One row per key; the flush adds to it (ON CONFLICT on these expressions).
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS traffic_filter_days_key_uq
         ON traffic_filter_days (day, kind, reason, label, country, (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)))`
    );
    await qi.addIndex('traffic_filter_days', ['workspace_id', 'day'], { name: 'traffic_filter_days_ws_day_idx' });

    await qi.createTable('traffic_store_days', {
      workspace_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      day: { type: DataTypes.DATEONLY, primaryKey: true, allowNull: false },
      stored_events: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      overflow_events: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      overflow_page_views: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      cap_reached_at: { type: DataTypes.DATE, allowNull: true },
      updated_at: now,
    });
    await qi.addIndex('traffic_store_days', ['day'], { name: 'traffic_store_days_day_idx' });

    await qi.createTable('traffic_salts', {
      day: { type: DataTypes.DATEONLY, primaryKey: true, allowNull: false },
      salt: { type: DataTypes.STRING(64), allowNull: false },
      created_at: now,
    });

    await setNotificationTypes(queryInterface, (types) => (types.includes('traffic_cap') ? types : [...types, 'traffic_cap']));
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.sequelize.query("DELETE FROM platform_notifications WHERE type = 'traffic_cap'");
    await queryInterface.sequelize.query("DELETE FROM platform_notification_prefs WHERE type = 'traffic_cap'");
    await setNotificationTypes(queryInterface, (types) => types.filter((t) => t !== 'traffic_cap'));

    await qi.dropTable('traffic_salts');
    await qi.dropTable('traffic_store_days');
    await qi.dropTable('traffic_filter_days');
    // Quarantined events go back where they came from before their table goes.
    const [[quarantine]] = await queryInterface.sequelize.query("SELECT to_regclass('public.analytics_quarantine_events') AS oid");
    if (quarantine.oid) {
      const [columns] = await queryInterface.sequelize.query(
        `SELECT e.column_name AS name
           FROM information_schema.columns e
           JOIN information_schema.columns q
             ON q.table_schema = e.table_schema AND q.table_name = 'analytics_quarantine_events' AND q.column_name = e.column_name
          WHERE e.table_schema = current_schema() AND e.table_name = 'analytics_events'
          ORDER BY e.ordinal_position`
      );
      // A website, funnel or order deleted since then is dropped from the row
      // (their foreign keys are ON DELETE SET NULL on analytics_events too).
      const REFS = { website_id: 'websites', funnel_id: 'funnels', order_id: 'orders' };
      const names = columns.map((c) => `"${c.name}"`).join(', ');
      const values = columns
        .map((c) => (REFS[c.name] ? `(SELECT r.id FROM ${REFS[c.name]} r WHERE r.id = q."${c.name}")` : `q."${c.name}"`))
        .join(', ');
      await queryInterface.sequelize.query(
        `INSERT INTO analytics_events (${names}) SELECT ${values} FROM analytics_quarantine_events q ON CONFLICT DO NOTHING`
      );
      await qi.dropTable('analytics_quarantine_events');
    }

    await queryInterface.sequelize.query('DROP INDEX CONCURRENTLY IF EXISTS analytics_sessions_flagged_at_idx');
    await queryInterface.sequelize.query('ALTER TABLE analytics_sessions DROP CONSTRAINT IF EXISTS analytics_sessions_flag_reason_check');
    for (const column of ['excluded_events', 'flagged_at', 'flag_reason', 'is_suspicious', 'is_bot', 'ip_hash']) {
      await qi.removeColumn('analytics_sessions', column);
    }
  },
};
