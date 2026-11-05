'use strict';

const { guarded } = require('../migrationGuards');

/**
 * The console's notifications about a creator's review of referral codes and
 * store agent links (referrals/referralReviewNotifications).
 *
 * platform_notifications.type   + 'referral_code_review', 'agent_link_review'
 *   (something waits for review) and 'referral_code_decided',
 *   'agent_link_decided' (it was approved or rejected)
 * platform_notifications.recipient_user_ids   null: everyone the type's
 *   permission opens it to, as every row before this. Otherwise only these
 *   accounts: a code's owner is told about their own codes, nobody else's.
 * platform_notifications.hidden_from_user_ids   who it is kept from, a creator
 *   aside: those who made what waits can't review it.
 *
 * Additive and run-twice safe: nullable columns (nothing is rewritten), and the
 * types added only when missing. down removes both, the notifications of the
 * types first.
 */

const NEW_TYPES = ['referral_code_review', 'referral_code_decided', 'agent_link_review', 'agent_link_decided'];
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
    await qi.addColumn('platform_notifications', 'recipient_user_ids', { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: true });
    await qi.addColumn('platform_notifications', 'hidden_from_user_ids', { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: true });
    await setNotificationTypes(queryInterface, (types) => [...types, ...NEW_TYPES.filter((t) => !types.includes(t))]);
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.sequelize.query(`DELETE FROM platform_notifications WHERE type IN (${list(NEW_TYPES)})`);
    await queryInterface.sequelize.query(`DELETE FROM platform_notification_prefs WHERE type IN (${list(NEW_TYPES)})`);
    await setNotificationTypes(queryInterface, (types) => types.filter((t) => !NEW_TYPES.includes(t)));
    await qi.removeColumn('platform_notifications', 'hidden_from_user_ids');
    await qi.removeColumn('platform_notifications', 'recipient_user_ids');
  },
};
