'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The daily SMS caps (notifications/smsBudget.js, SMS_PLATFORM_DAILY_CAP and
 * SMS_STORE_DAILY_CAP). Nothing is written here while both are unset.
 *
 * sms_daily_usage   one row per UTC day and scope
 *   scope_key       'platform' (every SMS the platform sends) or
 *                   'store:<workspace id>' (the SMS sent for one store)
 *   workspace_id    the store of a store row; null on the platform row
 *   sent            SMS let through that day (counted before the provider
 *                   is called, delivered or not)
 *   refused         SMS kept back because the cap was reached
 *   cap_reached_at  when the first one was kept back
 * platform_notifications.type   + 'sms_cap' (a cap was reached; once a day per scope)
 *
 * Additive and run-twice safe: a new table (nothing large is locked) and the
 * notification type added only when missing. down removes both, the
 * notifications of the type first.
 */

const NOTIFICATION_CHECKS = [
  ['platform_notifications', 'platform_notifications_type_check'],
  ['platform_notification_prefs', 'platform_notification_prefs_type_check'],
];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

async function notificationTypes(queryInterface, name) {
  const [rows] = await queryInterface.sequelize.query('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = :name', {
    replacements: { name },
  });
  if (rows.length === 0) return null;
  return [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

async function setNotificationTypes(queryInterface, change) {
  for (const [table, name] of NOTIFICATION_CHECKS) {
    const current = await notificationTypes(queryInterface, name);
    if (!current) continue;
    const next = change(current);
    if (next.length === current.length && next.every((t) => current.includes(t))) continue;
    await queryInterface.sequelize.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`);
    await queryInterface.sequelize.query(`ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (type IN (${list(next)}))`);
  }
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await qi.createTable('sms_daily_usage', {
      day: { type: DataTypes.DATEONLY, primaryKey: true, allowNull: false },
      scope_key: { type: DataTypes.STRING(60), primaryKey: true, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      sent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      refused: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cap_reached_at: { type: DataTypes.DATE, allowNull: true },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await qi.addIndex('sms_daily_usage', ['workspace_id', 'day'], { name: 'sms_daily_usage_ws_day_idx' });

    await setNotificationTypes(queryInterface, (types) => (types.includes('sms_cap') ? types : [...types, 'sms_cap']));
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.sequelize.query("DELETE FROM platform_notifications WHERE type = 'sms_cap'");
    await queryInterface.sequelize.query("DELETE FROM platform_notification_prefs WHERE type = 'sms_cap'");
    await setNotificationTypes(queryInterface, (types) => types.filter((t) => t !== 'sms_cap'));
    await qi.dropTable('sms_daily_usage');
  },
};
