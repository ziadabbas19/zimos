'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('analytics_events', {
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
      website_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'websites', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      funnel_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'funnels', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      visitor_id: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      session_id: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      dedupe_id: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      event_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      source: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      medium: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      campaign: {
        type: DataTypes.STRING(150),
        allowNull: true,
      },
      referrer: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      landing_page: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      click_ids: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      order_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'orders', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      revenue_amount: {
        type: DataTypes.BIGINT,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('analytics_events', ["workspace_id","event_name","created_at"], { unique: false, name: 'analytics_events_workspace_id_event_name_created_at_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('analytics_events');
  },
};
