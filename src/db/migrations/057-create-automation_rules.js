'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('automation_rules', {
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
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      trigger: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      conditions: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      actions: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('automation_rules', ["workspace_id","trigger"], { unique: false, name: 'automation_rules_workspace_id_trigger_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('automation_rules');
  },
};
