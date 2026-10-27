'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Device notifications (Web Push, modules/notifications/push): the browsers
 * subscribed to them. Nothing is written here while PUSH_ENABLED is off.
 *
 * push_subscriptions   one row per browser subscription
 *   user_id            whose; the row goes with the account
 *   session_id         the sign-in session it was made under. A refresh moves
 *                      it to the next session; it goes when the session ends
 *                      (and with the row, if a session row is ever deleted)
 *   app                'dashboard' or 'console' (two sites, two subscriptions)
 *   endpoint           the push service URL the browser handed over; only the
 *                      push services' own hosts are accepted (pushEndpoints.js)
 *   endpoint_hash      SHA-256 of endpoint, unique: one browser, one account
 *   p256dh, auth       the browser's keys for encrypting what is sent
 *   push_service       'fcm', 'mozilla', 'apple' or 'windows', from the host
 *   device_label       e.g. "Chrome on Windows", from the user agent
 *   locale             the language of the text sent ('ar', 'en')
 *   enabled            the device switched on; off after 5 failures in a row
 *   failure_count, last_error, last_success_at, last_failure_at
 *   last_seen_at       last subscribed or confirmed by the browser; a row not
 *                      seen for 60 days is removed by the daily cleanup
 *
 * Additive and run-twice safe: a new table (nothing existing is locked for
 * long), its checks and indexes each added only when missing. down drops it.
 */

const APPS = ['dashboard', 'console'];
const SERVICES = ['fcm', 'mozilla', 'apple', 'windows'];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await qi.createTable('push_subscriptions', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      session_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'sessions', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      app: { type: DataTypes.STRING(16), allowNull: false },
      endpoint: { type: DataTypes.TEXT, allowNull: false },
      endpoint_hash: { type: DataTypes.CHAR(64), allowNull: false },
      p256dh: { type: DataTypes.STRING(200), allowNull: false },
      auth: { type: DataTypes.STRING(100), allowNull: false },
      push_service: { type: DataTypes.STRING(16), allowNull: false },
      device_label: { type: DataTypes.STRING(120), allowNull: true },
      locale: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'ar' },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      failure_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_error: { type: DataTypes.STRING(200), allowNull: true },
      last_success_at: { type: DataTypes.DATE, allowNull: true },
      last_failure_at: { type: DataTypes.DATE, allowNull: true },
      last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });

    await qi.addConstraint('push_subscriptions', {
      type: 'check',
      name: 'push_subscriptions_app_check',
      fields: ['app'],
      where: { app: APPS },
    });
    await qi.addConstraint('push_subscriptions', {
      type: 'check',
      name: 'push_subscriptions_push_service_check',
      fields: ['push_service'],
      where: { push_service: SERVICES },
    });
    await qi.addIndex('push_subscriptions', ['endpoint_hash'], { name: 'push_subscriptions_endpoint_hash_key', unique: true });
    await qi.addIndex('push_subscriptions', ['user_id', 'app'], { name: 'push_subscriptions_user_app_idx' });
    await qi.addIndex('push_subscriptions', ['session_id'], { name: 'push_subscriptions_session_idx' });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.dropTable('push_subscriptions');
  },
};
