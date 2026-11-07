'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Device notifications for the console (platformAdmin/consolePush.js): what the
 * console's bell says, sent to the devices of the accounts it is shown to.
 * Nothing is written here while PUSH_ENABLED is off.
 *
 * platform_notification_prefs.push   per admin and type: sent to their devices
 *   or not. NULL (every row before this) is the default: on, so whatever their
 *   bell shows reaches their devices until they turn a type off.
 *
 * platform_notification_pushes   what already reached each account's devices,
 *   so the same event is sent once: one row per notification and account.
 *   event_at    the notification's created_at when it was sent; a waiting
 *               review that changes again moves its row's created_at on (the
 *               bell shows it as new), and only then is it sent again
 *   created_at  rows older than 3 days are removed by the daily cleanup
 *
 * Additive and run-twice safe: a nullable column (nothing is rewritten) and a
 * new table, each added only when missing. down drops both.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await qi.addColumn('platform_notification_prefs', 'push', { type: DataTypes.BOOLEAN, allowNull: true });
    await qi.createTable('platform_notification_pushes', {
      notification_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'platform_notifications', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      user_id: { type: DataTypes.UUID, primaryKey: true, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      event_at: { type: DataTypes.DATE, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await qi.addIndex('platform_notification_pushes', ['created_at'], { name: 'platform_notification_pushes_created_at_idx' });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.dropTable('platform_notification_pushes');
    await qi.removeColumn('platform_notification_prefs', 'push');
  },
};
