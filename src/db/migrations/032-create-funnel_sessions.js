'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('funnel_sessions', {
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
      visitor_id: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      current_step_key: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      path: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      order_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'orders', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      attribution: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('funnel_sessions', ["funnel_id","visitor_id"], { unique: false, name: 'funnel_sessions_funnel_id_visitor_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('funnel_sessions');
  },
};
