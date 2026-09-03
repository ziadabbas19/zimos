'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('webhook_deliveries', {
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
      endpoint_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'webhook_endpoints', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      event_id: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      event_type: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      payload: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'delivered', 'failed', 'exhausted'),
        defaultValue: "pending",
        allowNull: false,
      },
      attempt_count: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      next_attempt_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      last_response_status: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      last_error: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('webhook_deliveries', ["endpoint_id"], { unique: false, name: 'webhook_deliveries_endpoint_id_idx' });
    await queryInterface.addIndex('webhook_deliveries', ["endpoint_id","event_id"], { unique: true, name: 'webhook_deliveries_endpoint_id_event_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('webhook_deliveries');
  },
};
