'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('sessions', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      refresh_token_hash: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
      },
      user_agent: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      ip_address: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      revoked_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      rotated_to_session_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('sessions', ["user_id"], { unique: false, name: 'sessions_user_id_idx' });
    await queryInterface.addIndex('sessions', ["refresh_token_hash"], { unique: true, name: 'sessions_refresh_token_hash_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('sessions');
  },
};
