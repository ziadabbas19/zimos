'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('payments', {
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
      provider_code: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('initialized', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'),
        defaultValue: "initialized",
        allowNull: false,
      },
      amount: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      currency: {
        type: DataTypes.STRING(3),
        allowNull: false,
      },
      provider_reference: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      masked_display: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      failure_reason: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('payments', ["workspace_id"], { unique: false, name: 'payments_workspace_id_idx' });
    await queryInterface.addIndex('payments', ["order_id"], { unique: false, name: 'payments_order_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('payments');
  },
};
