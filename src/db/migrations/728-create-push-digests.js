'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Device notifications gathered before they are sent (notifications/push/pushDigest.js).
 * Nothing is written here while PUSH_ENABLED is off.
 *
 * push_digests    one row per teammate, store and kind of notification still
 *                 waiting: the first one opens it and queues its send for the
 *                 end of the window (20 seconds for orders, 5 minutes per
 *                 WhatsApp conversation, an hour for lost orders); the ones
 *                 that follow only count. The send deletes the row, so one
 *                 that comes after it opens the next.
 *   group_key      the type, or the type and its conversation ("whatsapp.message:<id>")
 *   count          how many it gathered
 *   refs           ids of the latest one only (an order id, a conversation id):
 *                  never a customer's name, phone, address or message
 *   flush_at       when it is due; a sweep sends one whose queued send was lost
 *
 * Additive and run-twice safe: a new table, its index added only when missing.
 * down drops it.
 */

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await qi.createTable('push_digests', {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      user_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      type: { type: DataTypes.STRING(40), allowNull: false },
      group_key: { type: DataTypes.STRING(120), allowNull: false },
      count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      refs: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      first_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      last_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      flush_at: { type: DataTypes.DATE, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await qi.addIndex('push_digests', ['workspace_id', 'user_id', 'group_key'], { name: 'push_digests_open_key', unique: true });
    await qi.addIndex('push_digests', ['flush_at'], { name: 'push_digests_flush_at_idx' });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.dropTable('push_digests');
  },
};
