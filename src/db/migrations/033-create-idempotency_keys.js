'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('idempotency_keys', {
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
      scope: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      key: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      request_hash: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('processing', 'completed', 'failed'),
        defaultValue: "processing",
        allowNull: false,
      },
      response_status: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      response_body: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('idempotency_keys', ["workspace_id","scope","key"], { unique: true, name: 'idempotency_keys_workspace_id_scope_key_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('idempotency_keys');
  },
};
