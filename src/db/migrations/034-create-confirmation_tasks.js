'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('confirmation_tasks', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      order_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      status: {
        type: DataTypes.ENUM('queued', 'in_progress', 'done'),
        defaultValue: "queued",
        allowNull: false,
      },
      locked_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      locked_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      attempt_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      next_retry_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      outcome: {
        type: DataTypes.ENUM('confirmed', 'rejected', 'unreachable', 'postponed'),
        allowNull: true,
      },
      rejection_reason: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('confirmation_tasks', ["workspace_id","status"], { unique: false, name: 'confirmation_tasks_workspace_id_status_idx' });
    await queryInterface.addIndex('confirmation_tasks', ["order_id"], { unique: false, name: 'confirmation_tasks_order_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('confirmation_tasks');
  },
};
