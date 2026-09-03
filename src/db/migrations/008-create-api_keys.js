'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('api_keys', {
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
      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      key_prefix: {
        type: DataTypes.STRING(12),
        allowNull: false,
      },
      secret_hash: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      scopes: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      rate_limit_per_minute: {
        type: DataTypes.INTEGER,
        defaultValue: 60,
        allowNull: false,
      },
      last_used_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      revoked_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      created_by_user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('api_keys', ["workspace_id"], { unique: false, name: 'api_keys_workspace_id_idx' });
    await queryInterface.addIndex('api_keys', ["key_prefix"], { unique: true, name: 'api_keys_key_prefix_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('api_keys');
  },
};
