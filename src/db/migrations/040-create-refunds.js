'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('refunds', {
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
      payment_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'payments', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      reason: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('pending', 'processed', 'failed'),
        defaultValue: "pending",
        allowNull: false,
      },
      credit_note_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      processed_by_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('refunds', ["workspace_id"], { unique: false, name: 'refunds_workspace_id_idx' });
    await queryInterface.addIndex('refunds', ["order_id"], { unique: false, name: 'refunds_order_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('refunds');
  },
};
