'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('funnel_edges', {
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
      funnel_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'funnels', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      from_step_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      to_step_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      condition: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      priority: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('funnel_edges', ["funnel_id","from_step_key"], { unique: false, name: 'funnel_edges_funnel_id_from_step_key_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('funnel_edges');
  },
};
