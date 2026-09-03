'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('funnels', {
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
      subdomain: {
        type: DataTypes.STRING(100),
        allowNull: true,
        unique: true,
      },
      status: {
        type: DataTypes.ENUM('draft', 'published', 'paused'),
        defaultValue: "draft",
        allowNull: false,
      },
      published_revision_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('funnels', ["workspace_id"], { unique: false, name: 'funnels_workspace_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('funnels');
  },
};
