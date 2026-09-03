'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('audit_logs', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      actor_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      action: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      entity_type: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      entity_id: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      ip_address: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      user_agent: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      before_state: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      after_state: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('audit_logs', ["workspace_id","created_at"], { unique: false, name: 'audit_logs_workspace_id_created_at_idx' });
    await queryInterface.addIndex('audit_logs', ["entity_type","entity_id"], { unique: false, name: 'audit_logs_entity_type_entity_id_idx' });
    await queryInterface.addIndex('audit_logs', ["actor_user_id"], { unique: false, name: 'audit_logs_actor_user_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('audit_logs');
  },
};
