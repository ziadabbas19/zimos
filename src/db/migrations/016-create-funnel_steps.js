'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('funnel_steps', {
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
      key: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      step_type: {
        type: DataTypes.ENUM('landing', 'sales', 'opt_in', 'checkout', 'upsell', 'downsell', 'thank_you', 'custom'),
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      builder_data: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      offer_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      ab_test_experiment_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      seo: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('funnel_steps', ["funnel_id","key"], { unique: true, name: 'funnel_steps_funnel_id_key_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('funnel_steps');
  },
};
