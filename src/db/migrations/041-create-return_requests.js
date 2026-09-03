'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('return_requests', {
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
      reason: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('requested', 'approved', 'rejected', 'received', 'refunded'),
        defaultValue: "requested",
        allowNull: false,
      },
      items: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      restocked_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('return_requests', ["workspace_id"], { unique: false, name: 'return_requests_workspace_id_idx' });
    await queryInterface.addIndex('return_requests', ["order_id"], { unique: false, name: 'return_requests_order_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('return_requests');
  },
};
